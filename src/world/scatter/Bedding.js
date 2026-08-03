import * as THREE from 'three';
import { rand2, clamp, smoothstep } from './Noise.js';

/**
 * ============================================================================
 * BEDDING — the contact shadow / dirt skirt under every prop.
 * ============================================================================
 *
 * Every one of the six blind forensic reports led with the same tell:
 *
 *   "No contact shadows or AO anywhere. The big foreground rock, the mid-ground
 *    boulders and the right-hand tree all sit on the ground with zero darkening
 *    at the intersection — they read as floating."
 *   "Grass tufts and boulders sit ON the terrain with no darkening at the
 *    intersection; several rocks visibly float or cut hard into the ground."
 *
 * Cascaded shadow maps cannot fix that on their own. At the resolution and
 * filter width a 900 m cascade runs, the shadow a 60 cm stone casts on the
 * ground 5 cm from its own base is below one texel — the occlusion that reads
 * as "this object is *resting* on that surface" is a sub-texel effect. Every
 * shipped open world therefore draws it explicitly, as a decal.
 *
 * So: one merged, terrain-conforming ribbon of irregular skirts, rebuilt with
 * the scatter around the camera, multiply-blended onto the ground.
 *
 *   • the inner lobe darkens toward the dust tint      → the contact shadow
 *   • the outer lobe is a wide, weak, noise-warped ring → wind-drifted debris
 *   • every skirt is a different irregular polygon      → never a decal disc
 *   • it conforms to `getHeight` per vertex             → never a floating quad
 *
 * ONE draw call for the whole world. ~24 triangles per prop, unlit, no shadow
 * pass, and it fades out entirely by 90 m so it costs nothing in the far field
 * and never needs aerial perspective (which is why the material is flagged
 * `rsNoAerial` — injecting a second haze term into a multiply decal would
 * double-count the scattering the ground underneath already carries).
 * ============================================================================
 */

const SIDES = 9;
const VERTS_PER = SIDES * 2 + 1;
const TRIS_PER = SIDES * 3;

export class Bedding {
  /**
   * @param {object} ctx
   * @param {THREE.Group} group
   * @param {{max?:number, range?:number, seed?:number}} [opts]
   */
  constructor(ctx, group, opts = {}) {
    this.ctx = ctx;
    this.range = opts.range || 92;
    this.seed = (opts.seed || 1) | 0;
    const max = opts.max || 1500;
    this.max = max;

    const g = new THREE.BufferGeometry();
    this._pos = new Float32Array(max * VERTS_PER * 3);
    this._col = new Float32Array(max * VERTS_PER * 3);
    this._idx = new Uint32Array(max * TRIS_PER * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this._col, 3));
    g.setIndex(new THREE.BufferAttribute(this._idx, 1));
    g.setDrawRange(0, 0);
    this.geom = g;

    /* Multiply blending, not alpha: the point is to *remove* light where the
       prop occludes the sky, which is a product, not a lerp toward a colour.
       Alpha-blending a grey disc over the ground washes out at night and turns
       milky in fog; a multiply behaves correctly under every exposure. */
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    /* dst * src, spelled out. THREE.MultiplyBlending is the same pair of
       factors but three insists on premultipliedAlpha with it, which drags in
       the premultiply fragment chunk for no benefit — the alpha channel is not
       part of this effect at all, so it is explicitly left alone. */
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.ZeroFactor;
    mat.blendDst = THREE.SrcColorFactor;
    mat.blendEquationAlpha = THREE.AddEquation;
    mat.blendSrcAlpha = THREE.ZeroFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.name = 'scatter_bedding';
    /*
     * NO polygon offset. A terrain-conforming skirt around a prop that is bedded
     * into a SLOPE has its upslope rim physically above the prop's base, and a
     * -3/-6 offset was enough to win the depth test there: every sunken stone
     * came back with a hard-edged black polygon notch cut out of its top, and
     * where two skirts overlapped the multiply squared and went to pure black.
     * The 3 cm world-space lift below is all the z-fight protection this needs,
     * and it leaves the depth test free to hide the skirt behind its own prop.
     */
    mat.polygonOffset = false;
    /* opt out of the aerial-perspective injection — see the header */
    mat.userData.rsNoAerial = true;
    this.material = mat;

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'scatter_bedding';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    /* a coplanar ground decal can only ever cast acne onto the surface it lies
       on — stay out of the cascades whatever the auto-caster heuristic decides */
    mesh.userData.rsNoShadow = true;
    mesh.updateMatrix();
    group.add(mesh);
    this.mesh = mesh;

    this.n = 0;
    this._ox = 0;
    this._oz = 0;
  }

  begin(ox, oz) { this.n = 0; this._ox = ox; this._oz = oz; }

  /**
   * Bed one prop into the ground.
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} radius footprint radius in metres
   * @param {number} dist   distance to the rebuild origin (for the range fade)
   * @param {number} [strength] 0..1 how dark the contact gets
   */
  add(x, z, radius, dist, strength = 1) {
    if (this.n >= this.max) return;
    if (dist > this.range) return;
    /* Anything below ~25 cm of footprint contributes almost nothing on its own
       and only adds to the multiplicative stack under a rock cluster, which is
       how the first version reached pure black. */
    if (radius < 0.25) return;
    const gh = this.ctx.world.getHeight;
    const r0 = Math.max(0.25, radius);
    /* The debris apron is proportionally wider for small stones than for a
       10 m outcrop — wind and runoff both work on a fixed absolute scale. */
    const r1 = r0 * (1.55 + 1.15 / (1 + r0 * 0.8));
    const fade = 1 - smoothstep(this.range * 0.55, this.range, dist);
    const k = clamp(strength, 0, 1) * fade;
    if (k < 0.02) return;

    const base = this.n * VERTS_PER;
    const P = this._pos, C = this._col;
    const h = rand2(Math.floor(x * 4.1), Math.floor(z * 4.1), this.seed);
    const ph = h * 6.283;

    /* centre */
    let vi = base;
    P[vi * 3] = x; P[vi * 3 + 1] = gh(x, z) + 0.030; P[vi * 3 + 2] = z;
    /* Neutral-to-warm, never cool. A first attempt tinted this toward blue on
       the theory that occlusion removes skylight; in a desert the light that
       survives under a rock is ground bounce, and a cool multiply put a visible
       blue halo round every boulder at noon. */
    const cDark = 1 - 0.44 * k;
    C[vi * 3] = cDark; C[vi * 3 + 1] = cDark * 0.985; C[vi * 3 + 2] = cDark * 0.955;
    vi++;

    for (let ring = 0; ring < 2; ring++) {
      for (let i = 0; i < SIDES; i++) {
        const a = (i / SIDES) * Math.PI * 2;
        /* irregular lobes: two harmonics with a per-prop phase, so no two
           skirts share an outline and none of them is a circle */
        const wob = 1 + Math.sin(a * 2 + ph) * 0.24 + Math.sin(a * 3 - ph * 1.7) * 0.15;
        const rr = (ring === 0 ? r0 * 0.60 : r1) * wob;
        const px = x + Math.cos(a) * rr;
        const pz = z + Math.sin(a) * rr;
        P[vi * 3] = px;
        P[vi * 3 + 1] = gh(px, pz) + 0.030;
        P[vi * 3 + 2] = pz;
        if (ring === 0) {
          const d = 1 - 0.34 * k;
          C[vi * 3] = d; C[vi * 3 + 1] = d * 0.985; C[vi * 3 + 2] = d * 0.955;
        } else {
          C[vi * 3] = 1; C[vi * 3 + 1] = 1; C[vi * 3 + 2] = 1;
        }
        vi++;
      }
    }

    let ii = this.n * TRIS_PER * 3;
    const I = this._idx;
    const inner = base + 1;
    const outer = base + 1 + SIDES;
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      I[ii++] = base; I[ii++] = inner + i; I[ii++] = inner + j;
      I[ii++] = inner + i; I[ii++] = outer + i; I[ii++] = outer + j;
      I[ii++] = inner + i; I[ii++] = outer + j; I[ii++] = inner + j;
    }
    this.n++;
  }

  flush() {
    const g = this.geom;
    g.setDrawRange(0, this.n * TRIS_PER * 3);
    if (this.n > 0) {
      g.attributes.position.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
      g.index.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  dispose() {
    this.geom.dispose();
    this.material.dispose();
  }
}
