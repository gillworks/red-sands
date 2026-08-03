import * as THREE from 'three';
import { buildMipChainRGBA, textureFromChain, LEAF_CUTOFF } from './VegTextures.js';

/**
 * Billboard impostor atlas, baked from the real LOD0 meshes at boot.
 *
 * Eight yaw slices per tree kind, laid out one kind per atlas row. The bake is a
 * flat pass-through of albedo x the geometry's baked ambient occlusion, written
 * *already sRGB-encoded* so the 8-bit atlas does not band in the shadows.
 *
 * THE ATLAS IS READ BACK AND RE-MIPPED ON THE CPU. That looks like an odd thing
 * to pay for at boot, but `glGenerateMipmap` is the direct cause of two pass-2
 * forensic findings:
 *
 *   - alpha is box-filtered without renormalisation, so a tree that covers 35%
 *     of its tile drops below any sane cutoff three mips down and the whole
 *     distant forest evaporates. Pass 2 papered over that by sliding the cutoff
 *     to 0.10 with distance, at which point the ENTIRE TILE passes instead —
 *     "flat camera-facing yellow smudges", "a rectangular blob".
 *   - RGB is box-filtered unassociated, so the transparent margin drags every
 *     distant canopy toward the clear colour and each billboard grows a halo.
 *
 * Building the chain with alpha-weighted colour and Castano coverage matching
 * fixes both, and lets the runtime use ONE constant cutoff at every distance.
 * The chain also stops while a tile is still a few texels wide, which is what
 * stops neighbouring yaw slices bleeding into each other.
 */

/** Constant alphaTest for the impostor atlas; baked into its mip coverage. */
export const IMPOSTOR_CUTOFF = 0.5;

const BAKE_VERT = /* glsl */`
varying vec2 vUvB;
varying float vAOB;
varying vec3 vColB;
void main() {
  vUvB = uv;
  vAOB = color.r;
  vColB = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BAKE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uMap;
uniform vec3 uTint;      // already in sRGB-ish space
uniform float uCut;
varying vec2 vUvB;
varying float vAOB;
varying vec3 vColB;
void main() {
  vec4 t = texture2D(uMap, vUvB);
  if (t.a < uCut) discard;
  /* vColB already carries the per-card hue jitter x baked AO, so the impostor
     inherits exactly the colour variation the mesh LOD has — which is what
     stops the LOD swap showing up as a tint step in the treeline. */
  gl_FragColor = vec4(t.rgb * uTint * (0.32 + 0.68 * vColB), 1.0);
}
`;

function toSrgbVec(color) {
  const f = (x) => Math.pow(Math.max(0, Math.min(1, x)), 1 / 2.2);
  return new THREE.Vector3(f(color.r), f(color.g), f(color.b));
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {Array<{bark:BufferGeometry, foliage:BufferGeometry|null,
 *                barkMap:Texture, barkTint:Color, leafMap:Texture,
 *                leafTint:Color, height:number}>} kinds
 * @returns {{texture:Texture, rows:number, cols:number,
 *            fit:Array<{half:number, centreY:number}>}}
 */
export function bakeImpostors(renderer, kinds, { tile = 192 } = {}) {
  const cols = 8;
  const rows = kinds.length;
  const W = cols * tile, H = rows * tile;
  const rt = new THREE.WebGLRenderTarget(W, H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  rt.texture.name = 'vegImpostorBake';

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100);
  const holder = new THREE.Group();
  scene.add(holder);

  const prevRT = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevShadow = renderer.shadowMap.enabled;
  const prevAuto = renderer.autoClear;

  renderer.shadowMap.enabled = false;
  renderer.autoClear = true;
  /* Clear RGB is irrelevant now — the CPU mip chain weights colour by alpha, so
     a zero-alpha texel contributes nothing. Kept mid-olive anyway so a stray
     bilinear tap at level 0 cannot pull an edge toward black. */
  renderer.setClearColor(0x6a6a4e, 0);
  rt.scissorTest = false;
  rt.viewport.set(0, 0, W, H);
  rt.scissor.set(0, 0, W, H);
  // NOTE: three latches a render target's viewport/scissor inside
  // setRenderTarget, so it has to be re-bound after every change.
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, false);
  rt.scissorTest = true;

  const fit = [];
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();

  for (let k = 0; k < rows; k++) {
    const kind = kinds[k];
    holder.clear();

    const barkMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: kind.barkMap },
        uTint: { value: toSrgbVec(kind.barkTint) },
        uCut: { value: 0.02 },
      },
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    const leafMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: kind.leafMap },
        uTint: { value: toSrgbVec(kind.leafTint) },
        uCut: { value: LEAF_CUTOFF },
      },
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    const barkMesh = new THREE.Mesh(kind.bark, barkMat);
    holder.add(barkMesh);
    if (kind.foliage) holder.add(new THREE.Mesh(kind.foliage, leafMat));

    box.makeEmpty();
    holder.traverse((o) => {
      if (!o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(o.geometry.boundingBox);
    });
    const radiusXZ = Math.max(
      Math.hypot(box.max.x, box.max.z), Math.hypot(box.min.x, box.min.z),
      Math.hypot(box.max.x, box.min.z), Math.hypot(box.min.x, box.max.z));
    const halfY = (box.max.y - box.min.y) * 0.5;
    const centreY = (box.max.y + box.min.y) * 0.5;
    const half = Math.max(radiusXZ, halfY) * 1.05 + 0.06;
    fit.push({ half, centreY });

    cam.left = -half; cam.right = half;
    cam.top = half; cam.bottom = -half;
    cam.near = 0.05; cam.far = half * 6 + 20;

    for (let a = 0; a < cols; a++) {
      const th = (a / cols) * Math.PI * 2;
      tmp.set(Math.cos(th), 0, Math.sin(th)).multiplyScalar(half * 3 + 6);
      cam.position.set(tmp.x, centreY, tmp.z);
      cam.lookAt(0, centreY, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();

      rt.viewport.set(a * tile, k * tile, tile, tile);
      rt.scissor.set(a * tile, k * tile, tile, tile);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    }

    barkMat.dispose();
    leafMat.dispose();
  }

  rt.scissorTest = false;
  rt.viewport.set(0, 0, W, H);
  rt.scissor.set(0, 0, W, H);

  /* ---- readback + coverage-preserving mip chain ------------------------- */
  const pixels = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, pixels);

  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.shadowMap.enabled = prevShadow;
  renderer.autoClear = prevAuto;

  /* readRenderTargetPixels returns GL row order (bottom-up), which is exactly
     the order a flipY = false DataTexture wants, and exactly the order the
     runtime UVs already assume — so no flip. */
  const chain = buildMipChainRGBA(pixels, W, H, cols, rows, IMPOSTOR_CUTOFF, 6, false);
  const texture = textureFromChain(chain, true, 8);
  texture.name = 'vegImpostorAtlas';
  rt.dispose();

  return { texture, target: null, rows, cols, tile, fit };
}
