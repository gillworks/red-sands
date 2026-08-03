import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Full-resolution lighting composite: folds ambient occlusion, screen-space
 * reflections and the volumetric buffer into the HDR image in one
 * bandwidth-friendly pass. Half-res inputs are upsampled with a depth-aware
 * 4-tap so nothing bleeds across a silhouette.
 *
 * Distance haze is NOT applied here — `sky` injects physically-derived aerial
 * perspective into the scene materials themselves. This pass only adds the
 * things that need the depth buffer.
 */
export function compositeMaterial(flags) {
  const defines = {};
  if (flags.ao) defines.USE_AO = 1;
  if (flags.ssr) defines.USE_SSR = 1;
  if (flags.volume) defines.USE_VOLUME = 1;

  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tHDR;
    uniform sampler2D tDepth;
    uniform sampler2D tAO;
    uniform sampler2D tVolume;
    uniform sampler2D tSSR;
    uniform sampler2D tExposure;
    uniform mat4 uInvViewProj;
    uniform vec3 uCamPos;
    uniform vec2 uHalfTexel;
    uniform vec2 uVolTexel;
    uniform float uNear, uFar;
    uniform float uAOStrength;
    uniform float uSubmerged;
    uniform vec3 uWaterFog;
    varying vec2 vUv;

    vec3 gtaoMultiBounce( float v, vec3 albedo ) {
      vec3 a =  2.0404 * albedo - 0.3324;
      vec3 b = -4.7951 * albedo + 0.6417;
      vec3 c =  2.7552 * albedo + 0.6903;
      return max( vec3( v ), ( ( v * a + b ) * v + c ) * v );
    }

    float linDepthAt( vec2 uv ) {
      return linear01( viewZFromDepth( texture2D( tDepth, uv ).r, uNear, uFar ), uNear, uFar );
    }

    /* Depth-aware bilateral 4-tap upsample. The texel argument is the SOURCE
       buffer's texel size, which is no longer the same for every input: AO and
       SSR run at half resolution, the volumetric raymarch at quarter. */
    vec4 upsampleAt( sampler2D tex, vec2 uv, float centerLin, vec2 texel ) {
      vec4 sum = vec4( 0.0 );
      float wsum = 0.0;
      vec2 o = texel * 0.5;
      vec2 offs[4];
      offs[0] = vec2( -o.x, -o.y ); offs[1] = vec2( o.x, -o.y );
      offs[2] = vec2( -o.x, o.y );  offs[3] = vec2( o.x, o.y );
      for ( int i = 0; i < 4; i++ ) {
        vec2 su = uv + offs[ i ];
        float sd = linDepthAt( su );
        float w = exp( -abs( sd - centerLin ) * 340.0 ) + 1e-3;
        sum += texture2D( tex, su ) * w;
        wsum += w;
      }
      return sum / wsum;
    }

    vec4 upsample( sampler2D tex, vec2 uv, float centerLin ) {
      return upsampleAt( tex, uv, centerLin, uHalfTexel );
    }

    void main() {
      vec3 col = texture2D( tHDR, vUv ).rgb;
      float rawD = texture2D( tDepth, vUv ).r;
      float lin = linear01( viewZFromDepth( rawD, uNear, uFar ), uNear, uFar );
      float exposure = texture2D( tExposure, vec2( 0.5 ) ).r;

      #ifdef USE_SSR
      {
        vec4 ssr = upsample( tSSR, vUv, lin );
        col = mix( col, ssr.rgb, SAT( ssr.a ) );
      }
      #endif

      #ifdef USE_AO
      if ( rawD < 0.9999 ) {
        float ao = SAT( upsample( tAO, vUv, lin ).r );
        /*
         * WHY PASS 2's AO WAS INVISIBLE.
         *
         * The 'albedo' fed to the fit is not albedo — it is the exposed
         * radiance of an already-lit pixel, which on sunlit ground sits at
         * 0.7-0.95. Feeding
         * that to the GTAO multi-bounce fit returns ~1.0 (a white surface
         * bounces all its occlusion back), and then a second term removed a
         * further 45% of whatever survived wherever the pixel was bright. On a
         * daylit frame the two together left roughly 5-10% of the computed
         * occlusion, which is why six independent reviewers wrote "no ambient
         * occlusion anywhere" about a build that had a working GTAO pass.
         *
         * Multi-bounce still belongs here — it is what keeps AO from reading as
         * dirt — but it has to be fed a plausible ALBEDO, so the radiance is
         * clamped into the range real western-palette surfaces actually live in
         * (0.10-0.55). The lit-surface exemption stays, at a third of its old
         * weight: it exists so that AO and the lighting system's screen-space
         * contact shadows compose instead of multiplying into a black seam at
         * every object/ground junction, not to erase AO from the frame.
         */
        vec3 albedo = clamp( col * exposure, vec3( 0.10 ), vec3( 0.55 ) );
        vec3 aoRGB = gtaoMultiBounce( ao, albedo );
        float lit = SAT( luma( col * exposure ) * 1.15 );
        aoRGB = mix( aoRGB, vec3( 1.0 ), lit * 0.15 );
        col *= mix( vec3( 1.0 ), aoRGB, uAOStrength );
      }
      #endif

      #ifdef USE_VOLUME
      {
        vec4 vol = upsampleAt( tVolume, vUv, lin, uVolTexel );
        col = col * SAT( vol.a ) + vol.rgb;
      }
      #endif

      if ( uSubmerged > 0.5 ) {
        vec3 wp = worldPosFromDepth( vUv, rawD, uInvViewProj );
        float dist = length( wp - uCamPos );
        float t = exp( -min( dist, 400.0 ) * 0.055 );
        col = col * t + uWaterFog * ( 1.0 - t );
      }

      gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
    }`, {
    tHDR: { value: null },
    tDepth: { value: null },
    tAO: { value: null },
    tVolume: { value: null },
    tSSR: { value: null },
    tExposure: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uHalfTexel: { value: new THREE.Vector2() },
    uVolTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
    uAOStrength: { value: 1 },
    uSubmerged: { value: 0 },
    uWaterFog: { value: new THREE.Vector3(0.05, 0.13, 0.16) },
  }, defines);
}
