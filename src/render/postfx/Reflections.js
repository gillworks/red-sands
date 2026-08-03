import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Screen-space reflections for wet ground and water, half resolution.
 * There is no G-buffer, so the surface mask is derived from depth:
 *   - water   : world Y within a hair of the water plane and facing up
 *   - wet mud : env.wetness on up-facing surfaces
 * Rays that leave the screen or run out of steps fall back to an analytic sky,
 * so reflections never punch a black hole in the frame.
 * Output: rgb = reflected radiance, a = blend weight (mask * Fresnel).
 */
export function ssrMaterial(steps) {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform sampler2D tBlue;
    uniform mat4 uProj;
    uniform mat4 uInvProj;
    uniform mat4 uInvViewProj;
    uniform mat3 uCamRot;
    uniform vec3 uCamPos;
    uniform vec3 uSunDir;
    uniform vec3 uSunRadiance;
    uniform vec3 uFogColor;
    uniform vec3 uZenith;
    uniform vec2 uFullTexel;
    uniform vec2 uHalfTexel;
    uniform vec2 uBlueScale;
    uniform float uWaterLevel;
    uniform float uWetness;
    /** Water system's baked depth field (metres of water; <= 0 is dry ground). */
    uniform highp sampler2D tWaterDepth;
    /** x = world half extent for the uv map, y = 1 when tWaterDepth is bound. */
    uniform vec2 uWaterInfo;
    uniform float uFrame;
    uniform float uMaxDist;
    uniform float uThickness;
    uniform float uNear, uFar;
    varying vec2 vUv;

    /** Snap to a full-res texel centre — see the note in Geometry.js: this pass
     *  is half res and tDepth is a full-res NearestFilter attachment. */
    vec2 snapUV( vec2 uv ) {
      return ( floor( uv / uFullTexel ) + 0.5 ) * uFullTexel;
    }
    vec3 vpos( vec2 uv ) {
      vec2 s = snapUV( uv );
      float d = texture2D( tDepth, s ).r;
      return viewPosFromDepth( s, d, uInvProj );
    }

    vec3 skyApprox( vec3 dir ) {
      float up = SAT( dir.y * 0.5 + 0.5 );
      vec3 c = mix( uFogColor, uZenith, pow( up, 0.65 ) );
      float s = SAT( dot( dir, uSunDir ) );
      c += uSunRadiance * ( pow( s, 260.0 ) * 0.6 + pow( s, 8.0 ) * 0.03 );
      return c;
    }

    void main() {
      float d0 = texture2D( tDepth, vUv ).r;
      if ( d0 >= 0.9999 ) { gl_FragColor = vec4( 0.0 ); return; }

      vec3 P = viewPosFromDepth( snapUV( vUv ), d0, uInvProj );
      vec2 tx = vec2( uHalfTexel.x, 0.0 ), ty = vec2( 0.0, uHalfTexel.y );
      vec3 pl = vpos( vUv - tx ), pr = vpos( vUv + tx );
      vec3 pb = vpos( vUv - ty ), pt = vpos( vUv + ty );
      vec3 ddx = ( abs( pr.z - P.z ) < abs( P.z - pl.z ) ) ? ( pr - P ) : ( P - pl );
      vec3 ddy = ( abs( pt.z - P.z ) < abs( P.z - pb.z ) ) ? ( pt - P ) : ( P - pb );
      vec3 nRaw = cross( ddx, ddy );
      float nLen = length( nRaw );
      if ( nLen < 1e-9 ) { gl_FragColor = vec4( 0.0 ); return; }
      vec3 N = nRaw / nLen;
      // Orient towards the eye. Testing N.z is NOT valid: level ground seen
      // by a level camera reconstructs to exactly (0,+-1,0), so the flip fired at
      // random per facet, wN.y came out -1 or +1 arbitrarily, and the Fresnel term
      // ran away -- which turned the wet storm plains into a blotchy mirror.
      if ( dot( N, P ) > 0.0 ) N = -N;
      vec3 wN = normalize( uCamRot * N );

      vec3 wp = worldPosFromDepth( vUv, d0, uInvViewProj );
      /*
       * IS THERE ACTUALLY WATER HERE?
       *
       * The height test below ("world Y within a hair of ctx.world.waterLevel")
       * is a proxy, and it is wrong in the direction that costs the most: this
       * world has no global sea. Water comes out of the hydrology solver, so a
       * reach can sit anywhere from 17.9 m to 430 m, and waterLevel is only
       * the elevation that genuinely sub-level ground gets flooded TO. Sampled
       * over the map, 0.31% of the DRY surface lies within 0.55 m of 18 m — and
       * because that is a contour, it is not scattered, it is a continuous band
       * of hillside that the test turned into a roughness-0.02 mirror. SSR is
       * the only half-res pass with no temporal filter and it re-jitters its ray
       * from blue noise every frame, so that band shimmered dark and light on
       * ordinary hillside for as long as the camera kept moving.
       *
       * Gate the height test on the water system's own baked depth field, which
       * is the same texture the water surface and the terrain's wet-margin band
       * already read. Strictly subtractive: real water keeps exactly the mask it
       * had, dry ground gets none. (The converse error — the 63% of real water
       * that sits too far from waterLevel to pass the height test and so gets
       * no SSR at all — is left alone here on purpose. Fixing it ADDS
       * reflections to rivers that do not have them today, which is a look
       * change, not a flicker fix, and it wants its own before/after pass.)
       */
      float isWater = 1.0;
      if ( uWaterInfo.y > 0.5 ) {
        vec2 wuv = ( wp.xz + uWaterInfo.x ) / ( 2.0 * uWaterInfo.x );
        isWater = ( wuv.x < 0.0 || wuv.y < 0.0 || wuv.x > 1.0 || wuv.y > 1.0 )
          ? 0.0
          : smoothstep( -0.06, 0.04, texture2D( tWaterDepth, wuv ).r );
      }
      float water = smoothstep( 0.55, 0.12, abs( wp.y - uWaterLevel ) )
        * smoothstep( 0.55, 0.9, wN.y ) * isWater;
      // Rain-soaked ground gets a grazing-angle sheen, not a mirror finish: it
      // keeps most of its albedo. Only the actual water plane reflects properly.
      float wet = uWetness * smoothstep( 0.35, 0.85, wN.y );
      float mask = SAT( max( water, wet * 0.17 ) );
      if ( mask < 0.015 ) { gl_FragColor = vec4( 0.0 ); return; }

      vec3 V = normalize( P );
      // Roughness follows the water mask alone; wet dirt scatters its reflection.
      float rough = mix( 0.20, 0.02, SAT( water ) );
      float n1 = texture2D( tBlue, vUv * uBlueScale + vec2( uFrame * 0.7548776, uFrame * 0.5698402 ) ).r;
      float n2 = texture2D( tBlue, vUv * uBlueScale * 1.37 + vec2( uFrame * 0.2465, uFrame * 0.8641 ) ).r;
      vec3 R = normalize( reflect( V, normalize( N + rough * ( vec3( n1, n2, n1 * n2 ) - 0.5 ) ) ) );

      // N now reliably faces the eye, so dot( -V, N ) is in [0,1] and the Fresnel
      // term can no longer overshoot into a full mirror.
      float fres = 0.02 + 0.98 * pow( SAT( 1.0 - SAT( dot( -V, N ) ) ), 5.0 );
      float weight = mask * SAT( fres * 2.2 + 0.02 );
      if ( weight < 0.004 ) { gl_FragColor = vec4( 0.0 ); return; }

      vec3 worldR = normalize( uCamRot * R );
      vec3 fallback = skyApprox( worldR );

      float stepLen = uMaxDist / float( STEPS );
      float jitter = fract( n1 + uFrame * 0.6180339887 );
      vec3 pos = P + N * max( 0.04, -P.z * 0.002 );
      vec3 hitColor = fallback;
      float hit = 0.0;
      float travelled = 0.0;

      for ( int i = 0; i < STEPS; i++ ) {
        float grow = 1.0 + float( i ) * 0.16;
        float adv = stepLen * grow;
        vec3 next = pos + R * adv * ( i == 0 ? ( 0.35 + jitter * 0.65 ) : 1.0 );
        travelled += adv;
        vec4 clip = uProj * vec4( next, 1.0 );
        if ( clip.w <= 0.0 ) break;
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) break;
        float sd = texture2D( tDepth, uv ).r;
        if ( sd >= 0.9999 ) { pos = next; continue; }
        float sceneZ = viewZFromDepth( sd, uNear, uFar );
        float diff = sceneZ - next.z;               // >0 → sample is behind geometry
        if ( diff > 0.0 && diff < uThickness * grow + adv ) {
          // binary refine
          vec3 a = pos, b = next;
          for ( int k = 0; k < 5; k++ ) {
            vec3 mid = ( a + b ) * 0.5;
            vec4 mc = uProj * vec4( mid, 1.0 );
            vec2 mu = mc.xy / mc.w * 0.5 + 0.5;
            float md = texture2D( tDepth, mu ).r;
            float mz = viewZFromDepth( md, uNear, uFar );
            if ( mz - mid.z > 0.0 ) b = mid; else a = mid;
          }
          vec4 fc = uProj * vec4( b, 1.0 );
          vec2 fu = fc.xy / fc.w * 0.5 + 0.5;
          vec2 edge = smoothstep( vec2( 0.0 ), vec2( 0.09 ), fu ) *
                      smoothstep( vec2( 0.0 ), vec2( 0.09 ), 1.0 - fu );
          float fade = edge.x * edge.y * SAT( 1.0 - travelled / uMaxDist );
          hitColor = mix( fallback, texture2D( tColor, fu ).rgb, fade );
          hit = 1.0;
          break;
        }
        pos = next;
      }

      gl_FragColor = vec4( hitColor, weight );
    }`, {
    tColor: { value: null },
    tDepth: { value: null },
    tBlue: { value: null },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamRot: { value: new THREE.Matrix3() },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunRadiance: { value: new THREE.Vector3(1, 1, 1) },
    uFogColor: { value: new THREE.Vector3(0.6, 0.66, 0.76) },
    uZenith: { value: new THREE.Vector3(0.2, 0.36, 0.66) },
    uFullTexel: { value: new THREE.Vector2() },
    uHalfTexel: { value: new THREE.Vector2() },
    uBlueScale: { value: new THREE.Vector2(1, 1) },
    uWaterLevel: { value: 18 },
    uWetness: { value: 0 },
    tWaterDepth: { value: null },
    uWaterInfo: { value: new THREE.Vector2(1, 0) },
    uFrame: { value: 0 },
    uMaxDist: { value: 42 },
    uThickness: { value: 0.9 },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
  }, { STEPS: Math.max(8, steps | 0) });
}
