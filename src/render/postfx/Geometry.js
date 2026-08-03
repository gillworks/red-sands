import * as THREE from 'three';
import { makeMaterial, GLSL_COMMON } from './Common.js';

/**
 * Geometry-derived buffers: motion vectors and ground-truth ambient occlusion.
 * Both are reconstructed from the depth buffer so no G-buffer is required of
 * the rest of the engine.
 */

/* ------------------------------------------------------------- velocity */

/**
 * Camera motion vectors, full res, RG16F, stored as a UV delta:
 *   prevUV = uv - velocity
 * Static geometry only; per-object motion is layered on top by PostFX using
 * `velocityObjectMaterial()`.
 */
export function velocityMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tDepth;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    varying vec2 vUv;
    void main() {
      float d = texture2D( tDepth, vUv ).r;
      vec3 wp = worldPosFromDepth( vUv, d, uInvViewProj );
      vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
      vec2 v = vec2( 0.0 );
      if ( pc.w > 1e-5 ) {
        vec2 prevUV = pc.xy / pc.w * 0.5 + 0.5;
        v = vUv - prevUV;
      }
      gl_FragColor = vec4( clamp( v, vec2( -2.0 ), vec2( 2.0 ) ), 0.0, 1.0 );
    }`, {
    tDepth: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
  });
}

/**
 * Per-object velocity, drawn over the camera-velocity buffer for registered
 * movers. Depth-tests manually against the scene depth so occluded movers do
 * not leak (the scene depth cannot be bound as an attachment here).
 */
export function velocityObjectMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      tDepth: { value: null },
      uPrevModelViewProj: { value: new THREE.Matrix4() },
      uCurrJitter: { value: new THREE.Vector2() },
      uPrevJitter: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <skinning_pars_vertex>
      uniform mat4 uPrevModelViewProj;
      varying vec4 vCurr;
      varying vec4 vPrev;
      void main() {
        /*
         * SKIN FIRST, THEN REPROJECT.
         *
         * Both the player and the horse are single SkinnedMeshes. Projecting
         * the raw position attribute would rasterise the BIND POSE — the velocity would land
         * on the wrong pixels entirely and be worse than no velocity at all.
         * The skinned vertex is used for both the current and the previous
         * clip position, so what this pass measures is the object's rigid root
         * motion with the pose held fixed. That is deliberate: keeping the
         * previous frame's bone matrices would cost a second bone texture, and
         * the root term is the one that is tens of pixels per frame while
         * riding. The residual limb motion is a couple of pixels and the TAA
         * neighbourhood clamp already handles it.
         */
        vec3 transformed = vec3( position );
        #include <skinbase_vertex>
        #include <skinning_vertex>
        vec4 wp = modelMatrix * vec4( transformed, 1.0 );
        vCurr = projectionMatrix * viewMatrix * wp;
        vPrev = uPrevModelViewProj * vec4( transformed, 1.0 );
        gl_Position = vCurr;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tDepth;
      uniform vec2 uCurrJitter;
      uniform vec2 uPrevJitter;
      uniform vec2 uResolution;
      varying vec4 vCurr;
      varying vec4 vPrev;
      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution;
        float sceneD = texture2D( tDepth, uv ).r;
        if ( gl_FragCoord.z > sceneD + 1e-6 ) discard;   // manual depth test
        vec2 c = vCurr.xy / max( vCurr.w, 1e-6 ) * 0.5 + 0.5;
        vec2 p = vPrev.xy / max( vPrev.w, 1e-6 ) * 0.5 + 0.5;
        c -= uCurrJitter;
        p -= uPrevJitter;
        gl_FragColor = vec4( clamp( c - p, vec2( -2.0 ), vec2( 2.0 ) ), 0.0, 1.0 );
      }`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  return m;
}

/* ----------------------------------------------------------------- GTAO */

/**
 * Ground-truth ambient occlusion (XeGTAO formulation): horizon search per
 * slice with a correct cosine-weighted arc integral. Half resolution.
 * Output RG16F: R = visibility, G = linear depth 0..1.
 */
export function gtaoMaterial(slices, steps) {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tDepth;
    uniform sampler2D tBlue;
    uniform mat4 uInvProj;
    uniform vec2 uResolution;     // half-res target size
    uniform vec2 uFullTexel;      // 1 / full-res size
    uniform vec2 uBlueScale;
    uniform float uNear, uFar;
    uniform float uRadius;        // world-space radius, metres
    uniform float uProjScale;     // pixels per metre at 1m
    uniform float uIntensity;
    uniform float uFrame;
    varying vec2 vUv;

    /**
     * tDepth is the FULL-res, NearestFilter depth attachment but this pass runs
     * at HALF res, so a raw half-res vUv lands exactly on a full-res texel
     * boundary and the nearest fetch is ambiguous. Snap every fetch to a
     * full-res texel centre and reconstruct from that same snapped uv, so the
     * position and the depth always agree.
     */
    vec2 snapUV( vec2 uv ) {
      return ( floor( uv / uFullTexel ) + 0.5 ) * uFullTexel;
    }
    vec3 vpos( vec2 uv ) {
      vec2 s = snapUV( uv );
      float d = texture2D( tDepth, s ).r;
      return viewPosFromDepth( s, d, uInvProj );
    }

    void main() {
      vec2 cUV = snapUV( vUv );
      float d0 = texture2D( tDepth, cUV ).r;
      if ( d0 >= 0.9999 ) { gl_FragColor = vec4( 1.0, 1.0, 0.0, 1.0 ); return; }

      vec3 P = viewPosFromDepth( cUV, d0, uInvProj );
      float lin = SAT( -P.z / uFar );

      // Edge-aware normal from depth. The baseline must be a whole half-res
      // texel: a single full-res texel is below this pass's sampling grid and
      // degenerates to a zero-length derivative.
      vec2 tx = vec2( 1.0 / uResolution.x, 0.0 );
      vec2 ty = vec2( 0.0, 1.0 / uResolution.y );
      vec3 pl = vpos( vUv - tx ), pr = vpos( vUv + tx );
      vec3 pb = vpos( vUv - ty ), pt = vpos( vUv + ty );
      vec3 ddx = ( abs( pr.z - P.z ) < abs( P.z - pl.z ) ) ? ( pr - P ) : ( P - pl );
      vec3 ddy = ( abs( pt.z - P.z ) < abs( P.z - pb.z ) ) ? ( pt - P ) : ( P - pb );
      vec3 nRaw = cross( ddx, ddy );
      float nLen = length( nRaw );
      // Degenerate derivative (flat/quantised depth) -> face the camera rather
      // than emit a NaN normal, which would blacken the whole neighbourhood.
      vec3 N = nLen > 1e-9 ? nRaw / nLen : vec3( 0.0, 0.0, 1.0 );
      // Orient towards the eye. Testing N.z is NOT sufficient: for level ground
      // under a level camera every reconstructed point shares the same view-space
      // y, so the cross product is exactly (0,+-1,0) and N.z is 0. The test then
      // never fires, the normal points into the ground, and the horizon integral
      // collapses to zero -- which is what blackened the whole near foreground.
      if ( dot( N, P ) > 0.0 ) N = -N;

      vec3 V = normalize( -P );

      float noise = texture2D( tBlue, vUv * uBlueScale + vec2( uFrame * 0.7548776, uFrame * 0.5698402 ) ).r;
      float noiseOffset = fract( noise + uFrame * 0.6180339887 );
      float noiseSlice = fract( noise * 3.0 + uFrame * 0.3819660113 );

      float pxRadius = clamp( uRadius * uProjScale / max( -P.z, 0.05 ), 3.0, 110.0 );
      float stepPx = pxRadius / float( STEPS );
      vec2 texel = 1.0 / uResolution;
      float invFalloff = 1.0 / max( uRadius * 0.45, 1e-3 );

      float visibility = 0.0;

      for ( int s = 0; s < SLICES; s++ ) {
        float phi = ( float( s ) + noiseSlice ) * ( PI / float( SLICES ) );
        vec2 omega = vec2( cos( phi ), sin( phi ) );
        vec3 dirV = vec3( omega, 0.0 );
        vec3 orthoDir = dirV - dot( dirV, V ) * V;
        vec3 axis = normalize( cross( dirV, V ) );
        vec3 projN = N - axis * dot( N, axis );
        float projNLen = length( projN );
        if ( projNLen < 1e-4 ) continue;
        float cosNorm = clamp( dot( projN, V ) / projNLen, -1.0, 1.0 );
        float sgn = sign( dot( orthoDir, projN ) );
        float n = sgn * acos( cosNorm );

        float lowCos0 = cos( n + PI * 0.5 );
        float lowCos1 = cos( n - PI * 0.5 );
        float h0 = lowCos0;
        float h1 = lowCos1;

        for ( int t = 0; t < STEPS; t++ ) {
          float dist = ( float( t ) + noiseOffset ) * stepPx + 1.0;
          vec2 off = omega * dist * texel;

          vec2 uvA = vUv + off;
          vec3 SA = vpos( uvA );
          vec3 dA = SA - P;
          float lA = length( dA );
          if ( lA > 1e-4 ) {
            float fA = SAT( ( uRadius - lA ) * invFalloff );
            float cA = dot( dA / lA, V );
            h0 = max( h0, mix( lowCos0, cA, fA ) );
          }

          vec2 uvB = vUv - off;
          vec3 SB = vpos( uvB );
          vec3 dB = SB - P;
          float lB = length( dB );
          if ( lB > 1e-4 ) {
            float fB = SAT( ( uRadius - lB ) * invFalloff );
            float cB = dot( dB / lB, V );
            h1 = max( h1, mix( lowCos1, cB, fB ) );
          }
        }

        float a0 = -acos( clamp( h1, -1.0, 1.0 ) );
        float a1 = acos( clamp( h0, -1.0, 1.0 ) );
        a0 = n + max( a0 - n, -PI * 0.5 );
        a1 = n + min( a1 - n, PI * 0.5 );
        float sinN = sin( n );
        float arc0 = 0.25 * ( -cos( 2.0 * a0 - n ) + cosNorm + 2.0 * a0 * sinN );
        float arc1 = 0.25 * ( -cos( 2.0 * a1 - n ) + cosNorm + 2.0 * a1 * sinN );
        visibility += projNLen * ( arc0 + arc1 );
      }

      visibility = SAT( visibility / float( SLICES ) );
      visibility = pow( visibility, uIntensity );
      gl_FragColor = vec4( visibility, lin, 0.0, 1.0 );
    }`, {
    tDepth: { value: null },
    tBlue: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFullTexel: { value: new THREE.Vector2() },
    uBlueScale: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.15 },
    uFar: { value: 12000 },
    uRadius: { value: 1.7 },
    uProjScale: { value: 500 },
    uIntensity: { value: 1.25 },
    uFrame: { value: 0 },
  }, { SLICES: slices, STEPS: steps });
}

/** Depth-aware 5x5 (sparse) denoise of the AO buffer. */
export function aoDenoiseMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tAO;
    uniform vec2 uTexel;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      vec2 c = texture2D( tAO, vUv ).rg;
      float sum = c.r * 0.4;
      float wsum = 0.4;
      for ( int i = 1; i <= 4; i++ ) {
        float fi = float( i );
        float w = exp( -fi * fi * 0.22 );
        vec2 o = uDir * uTexel * fi;
        vec2 a = texture2D( tAO, vUv + o ).rg;
        vec2 b = texture2D( tAO, vUv - o ).rg;
        float wa = w * exp( -abs( a.g - c.g ) * 900.0 );
        float wb = w * exp( -abs( b.g - c.g ) * 900.0 );
        sum += a.r * wa + b.r * wb;
        wsum += wa + wb;
      }
      gl_FragColor = vec4( sum / max( wsum, 1e-4 ), c.g, 0.0, 1.0 );
    }`, {
    tAO: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDir: { value: new THREE.Vector2(1, 0) },
  });
}

/** Temporal accumulation of AO with neighbourhood clamping. */
export function aoTemporalMaterial() {
  return makeMaterial(/* glsl */`
    ${GLSL_COMMON}
    uniform sampler2D tAO;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform vec2 uTexel;
    uniform float uFeedback;
    varying vec2 vUv;
    void main() {
      vec2 cur = texture2D( tAO, vUv ).rg;
      vec2 vel = texture2D( tVelocity, vUv ).rg;
      vec2 prevUV = vUv - vel;

      float mn = 1.0, mx = 0.0;
      for ( int y = -1; y <= 1; y++ ) {
        for ( int x = -1; x <= 1; x++ ) {
          float s = texture2D( tAO, vUv + vec2( float( x ), float( y ) ) * uTexel ).r;
          mn = min( mn, s ); mx = max( mx, s );
        }
      }

      float outAO = cur.r;
      if ( all( greaterThanEqual( prevUV, vec2( 0.0 ) ) ) && all( lessThanEqual( prevUV, vec2( 1.0 ) ) ) ) {
        vec2 h = texture2D( tHistory, prevUV ).rg;
        float hd = clamp( h.r, mn, mx );
        float depthTrust = exp( -abs( h.g - cur.g ) * 400.0 );
        outAO = mix( cur.r, hd, uFeedback * depthTrust );
      }
      gl_FragColor = vec4( outAO, cur.g, 0.0, 1.0 );
    }`, {
    tAO: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFeedback: { value: 0.9 },
  });
}
