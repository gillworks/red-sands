/**
 * Feeds the water depth field back into the terrain material so the ground
 * knows the river is there.
 *
 * Two effects, both driven by the same signed depth `d = surface - bed`:
 *
 *   d in [-band, 0]   the wet margin. Sand and gravel that has been under water
 *                     recently is darker and far smoother than the dry stuff
 *                     three metres up the bank, and that darkening band is the
 *                     thing that makes a waterline read as a waterline instead
 *                     of a decal edge. It also gives the SSR pass in PostFX
 *                     something physically sensible to reflect off.
 *   d > 0             the bed. Fully saturated: darker still, low roughness,
 *                     and the micro-relief flattened, because it is being seen
 *                     through moving water.
 *
 * Injected by chaining Terrain's own onBeforeCompile via registerMaterialUser.
 * Every string it touches is checked first; if Terrain's shader ever changes
 * shape we quietly do nothing rather than break the whole ground.
 */

const SHORE_FN = /* glsl */`
uniform highp sampler2D rsShoreDepth;
uniform vec4 rsShoreInfo;    // x = half extent, y = band metres, z = enable, w = wetnessBoost

void rsWaterShore() {
  if (rsShoreInfo.z < 0.5) return;
  vec2 uv = (vWorldPos.xz + rsShoreInfo.x) / (2.0 * rsShoreInfo.x);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return;
  float d = texture2D(rsShoreDepth, uv).r;
  if (d < -rsShoreInfo.y) return;

  /* margin: 0 at the top of the band, 1 at the waterline. Raised to a power so
     the darkening CONCENTRATES in the last metre instead of washing evenly over
     the whole band — a wet margin that fades linearly over five metres reads as
     a lighting change, not as a waterline. */
  float margin = smoothstep(-rsShoreInfo.y, -0.02, d);
  margin = margin * margin * (3.0 - 2.0 * margin);
  margin *= margin;
  // submerged: 0 at the waterline, 1 once there is real water over it
  float sub = smoothstep(0.0, 0.55, d);
  float wetK = max(margin, sub) * rsShoreInfo.w;

  // Saturated mineral ground: albedo drops toward its own square, which is what
  // a water film actually does (it kills the diffuse back-scatter), and the
  // colour warms very slightly as the darker grains dominate.
  vec3 dark = gDiffuse * (0.21 + 0.20 * gDiffuse) * vec3(1.05, 0.99, 0.91);
  gDiffuse = mix(gDiffuse, dark, wetK);
  gDiffuse = mix(gDiffuse, gDiffuse * vec3(0.86, 0.90, 0.94), sub * 0.55);

  gTerrainRough = mix(gTerrainRough, 0.13, wetK * 0.85);
  gTerrainNormal = normalize(mix(gTerrainNormal,
                                 normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz),
                                 sub * 0.35));
}
`;

/**
 * @param {object} terrain  the terrain system (needs registerMaterialUser)
 * @param {object} uniforms { rsShoreDepth, rsShoreInfo } — shared refs
 * @returns {boolean} true if at least one material was patched
 */
export function attachShore(terrain, uniforms) {
  if (!terrain || typeof terrain.registerMaterialUser !== 'function') return false;
  let patched = false;

  terrain.registerMaterialUser((mat) => {
    if (!mat || mat.userData.rsWaterShore) return;
    if (mat.isMeshDepthMaterial) return;                 // shadow pass: no shading
    mat.userData.rsWaterShore = true;

    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function') prev.call(this, shader, renderer);
      for (const k in uniforms) shader.uniforms[k] = uniforms[k];

      let f = shader.fragmentShader;
      if (f.indexOf('rsWaterShore') !== -1) return;
      const decl = 'gDiffuse = alb;\n}';
      const call = 'terrainSurface();';
      if (f.indexOf(decl) === -1 || f.indexOf(call) === -1) return;   // shader changed shape
      f = f.replace(decl, decl + '\n' + SHORE_FN);
      f = f.replace(call, call + '\n  rsWaterShore();');
      shader.fragmentShader = f;
    };

    const key = mat.customProgramCacheKey;
    mat.customProgramCacheKey = function () {
      return 'rsShore|' + (typeof key === 'function' ? key.call(this) : '');
    };
    mat.needsUpdate = true;
    patched = true;
  });

  return patched;
}
