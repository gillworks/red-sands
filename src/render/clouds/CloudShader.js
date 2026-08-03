/**
 * Volumetric cloud shaders.
 *
 *  MARCH_FRAG    front-to-back raymarch of a curved cloud shell, rendered at
 *                half resolution into an RGBA16F target.
 *                rgb = in-scattered radiance (premultiplied), a = 1 - T
 *  SHADOW_FRAG   top-down cloud-shadow map: for each ground texel, march the
 *                sun ray through the shell and record transmittance.
 *  RESOLVE_FRAG  temporal reprojection + neighbourhood clamp
 *  COMPOSITE_*   depth-aware bilateral upsample, drawn in-scene at the far
 *                plane so hardware depth testing occludes it behind terrain
 *
 * Author linear HDR. The composite has an optional fallback tonemap that is
 * only enabled while PostFX has not taken over the tonemap yet.
 *
 * ============================================================================
 *  PASS 4 REBUILD — why the deck read as "solid orange amoebas"
 * ============================================================================
 *  Measured on the pass-3 build: 7.8 % of the golden_hour sky was clipped at
 *  >0.97 with a hue-shifted R channel pinned at 1.0, i.e. flat orange paint.
 *  Three compounding causes, all fixed here:
 *
 *  1. OPTICAL DEPTH.  uSigma peaked at 0.104 /m. A single 36 m march step
 *     through density 1 therefore had an optical depth of 3.7 — the cloud went
 *     from transparent to opaque inside ONE step. That is, definitionally, a
 *     hard edge with a flat interior: there is no depth over which anything can
 *     gradate. Real cumulus extinction is 0.02–0.05 /m, so a fringe hundreds of
 *     metres deep is genuinely see-through. Sigma is now 0.009–0.030.
 *
 *  2. RADIANCE.  uSunScatter 2.05 put the lit face at ~3.5x the radiance of a
 *     white Lambertian card in the same light, which clipped the tonemap and
 *     destroyed every gradient inside the silhouette. Now ~1.0.
 *
 *  3. ONE SCALE, ONE THRESHOLD.  Coverage was a single hard remap of a single
 *     noise octave, so every cloud in the sky was the same ~1 km puff at the
 *     same altitude — confetti. Coverage is now a spatially varying WINDOW
 *     whose threshold is driven by a 45 km mass field: where that field is high
 *     the window opens wide and cells merge into a continuous deck, where it is
 *     low only the tallest peaks poke through as isolated fragments. That is
 *     the power-law size distribution a real cumulus field has.
 *
 *  Plus: subtractive (not renormalising) detail erosion so margins dissolve
 *  into wisps, a low scud layer on its own faster wind, and two high cirrus
 *  shells at different altitudes and drift rates for genuine parallax.
 */

/* ---------------------------------------------------------------- shared */

const COMMON = /* glsl */ `
precision highp float;
precision highp sampler3D;

const float PI = 3.14159265359;
/* Compressed planet radius: gives the cloud deck an honest curve to the
   horizon without needing a 200 km march. */
const float Rg = 3400000.0;
/* Nominal shell, used only by the temporal reprojection. The march itself
   reads uHB/uHT so a thunderstorm can push its tops to 11 km. */
const float HB = 1050.0;
const float HT = 5700.0;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

uniform vec3  uCamPos;
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec2  uTanHalf;

vec3 rayDir(vec2 uv, vec2 jitter) {
  vec2 ndc = uv * 2.0 - 1.0 + jitter;
  return normalize(uCamFwd + uCamRight * (ndc.x * uTanHalf.x) + uCamUp * (ndc.y * uTanHalf.y));
}
`;

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/* --------------------------------------------------------------------------
 *  DENSITY FIELD — shared by the camera march and the shadow-map pass so the
 *  shadow on the ground is cast by exactly the cloud you can see overhead.
 * -------------------------------------------------------------------------- */

const DENSITY_GLSL = /* glsl */ `
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform sampler2D uWeather;

uniform float uCoverage;
uniform float uDensityMul;
uniform float uCloudType;
uniform float uCirrus;
uniform float uScud;          // 0..1 amount of low ragged fragments
uniform vec3  uAdvect;        // accumulated wind displacement, metres
uniform float uTime;

uniform float uShapeScale;
uniform float uDetailScale;
uniform float uWeatherScale;
uniform float uSigma;         // peak extinction, 1/m
uniform vec2  uWindDir;       // normalised horizontal wind direction

uniform float uHB;            // shell base, metres
uniform float uHT;            // shell top, metres
uniform float uShear;         // metres of downwind lean per unit height frac
uniform float uAnvil;         // 0..1 how much the top spreads into an anvil
uniform float uMaxDist;

/* -- height profile per cloud type --------------------------------------
   Wider transitions than pass 3. A slab whose top and bottom are cut by a
   narrow smoothstep terminates in a straight line; feathering the envelope
   over a third of the profile is half of what makes a base look like a base
   instead of a floor. */
vec4 typeGradient(float t) {
  vec4 st = vec4(0.000, 0.055, 0.145, 0.330);   // stratus: low, flat, thin
  vec4 cu = vec4(0.012, 0.145, 0.470, 0.860);   // cumulus: wider than tall
  vec4 cb = vec4(0.000, 0.040, 0.720, 1.000);   // cumulonimbus: towering
  return t < 0.5 ? mix(st, cu, smoothstep(0.0, 0.5, t))
                 : mix(cu, cb, smoothstep(0.5, 1.0, t));
}

/* -- density field ------------------------------------------------------ */
float cloudDensity(vec3 wp, float hf, float t, bool detail) {
  /* Wind shear: the top of a cell is dragged downwind relative to its base.
     Displacing the sample position by -wind*h leans the whole tower, which is
     the single strongest cue that a cloud has vertical extent at all. The
     advection multiplier also RISES with altitude, so the deck's own layers
     slide over each other — free parallax inside one march. */
  /* SHEAR IS A SMEAR OPERATOR — keep it well under the feature size.
     A vertical ray samples the shape field along a horizontal line whose length
     is the total shear across the shell. When that line was 1.8 km of uShear
     plus 1.25x the accumulated advection, against ~3 km shape features, the
     field got combed along the wind and a storm sky rendered as long sinuous
     bright ribbons — a brushed-metal look that survived four separate attempts
     to fix it as an erosion, scud or optical-depth problem. It was never any of
     those: it is this line. Keep the total displacement to a fraction of a
     feature and the tower leans without smearing. */
  vec3 p = wp - uAdvect * (0.70 + hf * 0.45);
  p.xz -= uWindDir * (hf * hf * uShear);

  vec2 wuv = p.xz * uWeatherScale;
  vec4 wm = texture(uWeather, wuv);                    // cell scale
  /* A 2.5x lower-frequency read of the same field: this is the MASS field,
     and it is what turns a confetti sky into an organised one. At 0.28 its
     period was 45 km — wider than the whole visible sky, so a frame got one
     mass and one hole and read as arbitrary. 0.40 puts two or three masses in
     shot, which is what a composition needs. */
  vec4 wl = texture(uWeather, wuv * 0.40 + 0.37);

  float macro = wl.r;

  /* Per-cell type variation is what stops every cloud in a field being the
     same shape: neighbouring cells become flatter or taller than the weather
     system's nominal cloudType, so a field has both squat pancakes and
     congestus towers in it. */
  float typeLocal = clamp(uCloudType + (wm.g - 0.5) * 0.52 + (wl.g - 0.5) * 0.30, 0.0, 1.0);
  vec4 g = typeGradient(typeLocal);
  /* Let the deck undulate so bases and tops are not all at one altitude — but
     scale it DOWN for convective decks. This undulation is applied as a shift
     in shell fraction, and a storm shell is 10.8 km deep against a fair-weather
     3.5 km, so the same 0.17 that gives a cumulus field 600 m of pleasant
     variation punches 1.8 km holes clean through a cumulonimbus base. Seen from
     650 m underneath, holes in a plane that runs to the horizon foreshorten
     into long bright ribbons, which is where storm_plains' brushed-metal sky
     came from.

     TWO SCALES, and the second one is the point. wm.a varies per CELL, which
     only ever makes neighbouring puffs sit at slightly different heights. wl.a
     is the same field read at 0.40x — a ~19 km period — so whole REGIONS of the
     deck ride high or low, and a wide shot gets two or three genuinely
     separated altitude bands receding into the distance instead of one ceiling
     at one altitude. That stratification is most of what makes a sky read as
     deep rather than as a lid. */
  /* PASS 11. The region-scale term is pulled 0.25 -> 0.17. At 0.25 a
     fair-weather deck's REGIONS rode so far apart in altitude that neighbouring
     masses shared no common base plane at all, and with coverage low enough for
     them to be separate objects the sky read as unrelated wads pasted at random
     heights (the "inconsistent altitude" verdict). 0.17 still gives ~600 m of
     regional stratification across a 3.5 km shell — enough to read as depth —
     while leaving one recognisable deck. */
  float undul = (wm.a - 0.5) * mix(0.15, 0.075, uAnvil)
              + (wl.a - 0.5) * mix(0.17, 0.055, uAnvil);
  /* BASE RELIEF, convective decks only.
     The undulation above is deliberately almost switched off for a Cb, because
     a shift in shell fraction that large punches holes through a 10.8 km tower.
     The cost of that was a base with NO height variation whatsoever: the lid
     term below floors the density under a constant shell fraction, so the
     underside terminated in a dead-flat plane and storm_plains rendered a slab
     with a ruler-straight bottom silhouette. This is the missing degree of
     freedom — a low-frequency shift applied ONLY in the bottom third, where it
     can lift and drop the base by a few hundred metres but cannot reach high
     enough to open a hole in the mass above it. */
  undul += (wl.b - 0.5) * 0.055 * uAnvil * (1.0 - smoothstep(0.0, 0.34, hf));
  float h = clamp(hf + undul, 0.0, 1.0);

  /* --- anvil: above the equilibrium level a cumulonimbus stops rising and
     spreads sideways into a flat, smooth, downwind-trailing sheet.
     GATED BY THE CELL. An anvil belongs to the storm that made it: it spreads
     tens of kilometres downwind of that cell and no further. */
  float cellMask = sat(remap(macro, 0.34, 0.78, 0.0, 1.0));
  float anvil = uAnvil * smoothstep(0.44, 0.86, h) * mix(0.22, 1.0, cellMask);

  float hgrad = smoothstep(g.x, g.y, h) * (1.0 - smoothstep(g.z, g.w, h));
  hgrad = max(hgrad, anvil * (1.0 - smoothstep(0.88, 1.04, h)) * 0.92);
  if (hgrad <= 0.002) return 0.0;

  /* ------------------------------------------------------ COVERAGE WINDOW
     The threshold is a FIELD, not a constant. Where the 46 km mass field is
     high the window sits low and neighbouring cells merge into one continuous
     deck; where it is low the window sits high and only the tallest peaks of
     the cell noise poke through, as isolated fragments. Sweeping the threshold
     like this is what produces a size distribution — a few big masses, many
     medium, lots of small — instead of one puff size everywhere.

     CALIBRATION NOTE. The first cut of this used smoothstep(thr, thr+win, cw)
     with the window centred on cw's mean, which is wrong by construction: cw's
     histogram is roughly symmetric about 0.5, so a window opening at 0.5 keeps
     only the top tail and the entire sky came back empty. The linear ramp
     below is centred BELOW the mean on purpose. */
  float cw = mix(wm.r, wm.b, 0.30);
  /* 0.955 -> 0.922. The smoothstep mass redistribution above deliberately
     thins the outer band of every puff, and the heavier detail bite takes more
     off the margins again, so at the old threshold a whole tier of marginal
     cells stopped clearing the coverage window and the sky came back noticeably
     emptier than the reference. Opening the window puts the mass back where it
     was while keeping the new profile. */
  /* PASS 11. 0.922 -> 0.900, and the window is WIDER.
     Two separate defects, one line each:
       - the threshold. Measured against the pass-9 frames, golden_hour_vista's
         cloud coverage fell by roughly half and high_noon_desert lost its whole
         horizon band; the sky came back as a handful of isolated wads over bare
         blue. Dropping the threshold 0.022 puts that tier of marginal cells
         back without touching the shape of the ones that survived.
       - the WINDOW WIDTH, which is what actually decides how hard a silhouette
         is. 'coverage' is the local mass fraction, and it feeds both the remap
         that carves the outline and the mix(0.40,1.0,coverage) that thins it;
         a narrow window means a cell goes from "not there" to "full density"
         across a very short distance in the mass field, i.e. the outline snaps.
         0.72 -> 1.00 spreads that transition over ~40% more of the field and is
         most of what turns a cut-out back into something with a dissolved
         margin. */
  float thr = 0.880 - uCoverage * 1.06 - (macro - 0.5) * 0.54 - anvil * 0.20;
  float coverage = sat((cw - thr) / max(uCoverage * 0.88, 0.14));
  if (coverage <= 0.004) return 0.0;

  /* VERTICAL COHERENCE. Squashing the sample along Y raises the vertical
     frequency, right for a field of fair-weather cumulus (wider than tall) and
     wrong for a cumulonimbus, where one updraft must stay one connected mass
     from base to anvil. */
  float vFreq = mix(1.62, 0.96, uAnvil);
  vec4 s = texture(uShape, p * uShapeScale * vec3(1.0, vFreq, 1.0));
  float wfbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  /* Do NOT "tighten" this lower bound. It looks like a contrast control and it
     is actually a mean control: wfbm-1.0 is negative, so the divisor is ~1.5
     and the field lands around 0.75. Pulling the bound up to wfbm*0.88-0.12
     drops the mean to 0.46, which is BELOW 1-coverage for typical coverage —
     and the whole sky comes back empty. Measured that the hard way. */
  float base = sat(remap(s.r, wfbm - 1.0, 1.0, 0.0, 1.0));
  // the Perlin-Worley remap compresses the histogram badly; put the contrast
  // back or the coverage threshold cuts vertical-sided boxes out of a slab
  base = sat(remap(base, 0.26, 0.96, 0.0, 1.0));
  // the anvil is a smooth ice sheet, not a lumpy cell
  base = mix(base, mix(base, 0.82, 0.70), anvil);
  base *= hgrad;

  /* Two things happen at the margin, and pass 3 only did the first:
       remap()   carves the silhouette out of the shape field
       * coverage THINS it — the outer band keeps a genuinely low density, so a
                  ray crossing 200 m of it accumulates an optical depth of a few
                  tenths and you can see the sky through it.
     Without the second term every silhouette is a step function no matter how
     soft the noise underneath it is. */
  /* ------------------------------------------------- WHY THE PUFFS WERE BOXES
     This one line decides whether the silhouette is carved by the 3D shape
     volume or by the 2D coverage field, and at 0.92 it was the latter.

     The erosion threshold is 1 - coverage*0.92, so where the mass field is
     strong (coverage -> 1) the threshold falls to 0.08: ANY sample whose shape
     value clears 8 % survives, and after base*=hgrad that means the outline
     is simply "wherever hgrad is non-zero", i.e. the vertical extent of the
     height profile extruded through the horizontal outline of the coverage
     window. hgrad for a cumulus is a PLATEAU — flat 1.0 from h = 0.145 to
     h = 0.470 — so what gets drawn is a slab with vertical sides, a flat top and
     a flat bottom. That is exactly the "hard-edged blotchy cotton wad" and the
     "hard-edged cloud slab with a straight-line bottom" in the defect list, and
     no amount of erosion detail can fix it because erosion only bites the last
     few per cent off a shape that is already a box.

     Two changes:
       - the floor of the threshold is raised (0.92 -> 0.66), so even at full
         coverage a sample has to clear 34 % of the shape field. The silhouette
         is then a genuine iso-surface of a 3D noise volume, which is round.
       - TOP TAPER. A cumulus is widest at its condensation level and narrows
         into cauliflower as it rises; it does not terminate in a lid. Raising
         the threshold with height shrinks the horizontal cross-section as the
         cloud climbs, which is the whole of that read. The base stays flat
         because a real cumulus base IS flat — that is what the condensation
         level means — so the taper is one-sided.
     The mass lost to the higher floor is given back at the coverage window
     (thr 0.922 -> 0.880) rather than here, because that adds whole cells
     instead of inflating the ones already present. */
  float taper = 1.0 - 0.40 * smoothstep(0.28, 1.0, h) * (1.0 - uAnvil * 0.55);
  float d = sat(remap(base, 1.0 - coverage * 0.66 * taper, 1.0, 0.0, 1.0));
  /* REDISTRIBUTE MASS INWARD. smoothstep fixes 0 and 1 — it moves the
     silhouette nowhere — but it pushes the outer band of every puff down and
     the body up. That matters because the two things a cloud needs are
     mutually exclusive under a linear ramp: a fringe thin enough to dissolve
     into wisps AND a core opaque enough to have a genuinely dark base. A
     linear ramp with a low sigma gives soft fringes and a uniformly-lit
     interior (what we render now: airbrushed blobs with one tonal value);
     with a high sigma it gives a dark interior and a hard cut edge. Making the
     profile non-linear is what buys both at once, and it is why sigma can go
     back up to the physical 0.02-0.05 band in the same change. */
  d = d * d * (3.0 - 2.0 * d);
  d *= mix(0.40, 1.0, coverage);

  /* THE LID. Under a mature convective complex the bottom few hundred metres
     of the deck is continuous — no pinholes, no lace. Flooring the density
     there is what turns the base into the flat dark shelf that makes a storm
     read as threatening, and it stops every thin spot in the noise from
     becoming a bright filament when the base is viewed edge-on. Gated on
     anvil AND coverage, so a fair-weather cumulus never gets one.

     Keep it SHALLOW. At 0.32 of a 10.8 km shell the lid was 3.5 km thick and
     opaque, so the storm sky lost every trace of structure and read as night.
     0.11 is ~1.1 km: enough to close the base, thin enough that the mass above
     it still modulates what you see. */
  /* MODULATED, not a constant. A flat floor gives a base with exactly one
     value in it, which is the featureless grey ceiling storm_plains renders
     today — the measured local 8 px contrast in that sky is 0.008 against
     0.024-0.032 in the reference frames. Driving the floor with the mass field
     varies base thickness ~4x, so the underside gets large-scale relief that
     the erosion below then breaks into a shelf. */
  float lidMod = 0.45 + 1.00 * sat(remap(mix(wm.a, wl.b, 0.45), 0.24, 0.80, 0.0, 1.0));
  /* The lid's THICKNESS varies too, not just its density. A constant-thickness
     floor under a deck is a plane, and a plane seen from below terminates in a
     straight line however lumpy its density is. */
  float lid = uAnvil * sat((uCoverage - 0.50) / 0.30)
            * (1.0 - smoothstep(0.010, 0.06 + 0.13 * lidMod, h)) * lidMod;
  d = max(d, lid * 0.38);
  if (d <= 0.002) return 0.0;

  if (detail) {
    /* LOD: past a few km the finest octave is sub-pixel, so converge the
       erosion to a constant instead of letting it alias into speckle. Pulled
       in from 9-30 km because the march now runs out past 50 km.
       COMPUTED FIRST, AND IT GATES THE FETCHES. Once lod has converged the
       three uDetail reads below are being blended out to a constant anyway, so
       issuing them is pure cost — and with the extended reach the far field is
       now where most in-cloud samples live. */
    float lod = 1.0 - smoothstep(7000.0, 24000.0, t);
    float m = 0.5;
    vec3 dp = p * uDetailScale
            + vec3(0.0, uTime * 0.008, 0.0)
            - uAdvect * uDetailScale * 1.5;
    if (lod > 0.02) {
      vec3 dn = texture(uDetail, dp).rgb;
      float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
      // wispy shredded bottoms, cauliflower shoulders
      m = mix(0.5, mix(dfbm, 1.0 - dfbm, sat(h * 3.2)), lod);
    }
    // the anvil keeps its smooth ice-sheet edge
    m = mix(m, 0.30, anvil * 0.78);

    /* SUBTRACTIVE, not remapping. remap(d, m*k, 1, 0, 1) renormalises the core
       straight back to 1.0, so erosion only ever moves the hard edge around —
       it never makes anything thinner. Subtracting leaves every bitten sample
       genuinely less dense, which is what turns an outline into a fractal
       wisp. The bite is strongest where d is already small (the fringe) and
       nearly absent in the core, so the cloud keeps its mass. */
    float bite = (0.13 + 0.50 * (1.0 - d)) * mix(1.0, 0.62, uAnvil);
    /* A storm base is not a plate. The bottom few hundred metres of a mature
       cell break up into the lumpy shelf you actually look at from underneath,
       and that relief — not the mean brightness — is what makes a thunderhead
       legible. The lid above deliberately fills the base in; this cuts the
       lumps back out of it. */
    /* Safe to be generous again now that the light-march shortcut is gated on
       uAnvil: a fragment torn out of a storm base is no longer lit as though it
       were floating in clear midday air, so this reads as dark ragged relief
       silhouetted against the bright horizon slot rather than as the silvery
       white ceiling the first cut of this produced. */
    bite *= 1.0 + uAnvil * 1.00 * (1.0 - smoothstep(0.0, 0.16, h));
    d = max(0.0, d - m * bite);
    if (d <= 0.0015) return 0.0;

    // crown detail: a finer second bite on the convective shoulders, where the
    // cauliflower lives
    /* 0.05 -> 0.24. The crown bite is a THIRD detail fetch, and past ~13 km its
       feature size is well under a pixel so all it can do is add noise the
       temporal resolve then has to remove. Gating it earlier is the cheapest
       remaining saving in the march and it buys the margin the wider coverage
       window cost on forest_interior and river_bend. */
    if (lod > 0.24) {
      float fine = texture(uDetail, dp * 3.3 + 0.417).b;
      float shoulder = smoothstep(0.03, 0.32, h) * (1.0 - smoothstep(0.60, 0.98, h));
      shoulder = mix(shoulder, shoulder * 1.3, uAnvil);
      d = max(0.0, d - (1.0 - fine) * 0.17 * lod * shoulder * (1.0 - d * 0.45));
      if (d <= 0.0015) return 0.0;
    }
  }

  /* ------------------------------------------------------------ LOW SCUD
     Ragged fragments hanging a few hundred metres under the main bases, on
     their own much faster wind. In a still frame this is the cheapest signal
     that the sky has more than one layer in it; in motion the speed difference
     is the parallax that stops the deck reading as a painted ceiling. */
  /* IN METRES, NOT SHELL FRACTION. hf < 0.26 of a fair-weather 3.5 km shell is
     900 m — a plausible scud band — but 0.26 of a 10.8 km thunderstorm shell is
     2.8 km, so under the one sky that most needs ragged fragments hanging below
     the base the entire scud layer was being placed INSIDE the deck where it is
     invisible. Absolute metres above the shell base puts it where it belongs
     for every cloud type. */
  float hm = hf * (uHT - uHB);
  if (uScud > 0.01 && hm < 620.0) {
    vec3 q = wp - uAdvect * 2.3;
    /* Squash 1.8, not 3.4. A layer flattened by 3.4 is a SHEET, and the whole
       point of looking at an overcast base is that you look along it: every
       ray then runs kilometres inside that sheet and the surviving density
       resolves as long sinewy filaments. storm_plains came back looking like a
       marble texture. 1.8 keeps scud as ragged lumps that read as fragments. */
    vec4 sc = texture(uShape, q * (uShapeScale * 2.7) * vec3(1.0, 1.8, 1.0));
    float sf = sat(remap(sc.r, 0.40, 0.90, 0.0, 1.0));
    float prof = smoothstep(-25.0, 70.0, hm) * (1.0 - smoothstep(150.0, 600.0, hm));
    float sMask = sat(remap(wm.b, 0.30, 0.86, 0.0, 1.0));
    // patchier: scud is isolated fragments, never a continuous veil
    float sd = sat(remap(sf * sMask, 1.0 - uScud * 0.52, 1.0, 0.0, 1.0));
    d = max(d, sd * prof * 0.34 * uScud);
    if (d <= 0.0015) return 0.0;
  }

  // vertical density ramp: thin at the base, meaty above, feathered on top
  float ramp = mix(0.38, 1.0, sat(remap(h, g.x, g.x + (g.z - g.x) * 0.48, 0.0, 1.0)));
  ramp *= mix(1.0, 0.58, sat(remap(h, g.z, g.w, 0.0, 1.0)));
  /* A storm cell is optically thickest in the lower third: that is what makes
     the base read as a flat black lid while the shoulders stay bright. */
  /* 2.40 -> 1.95: the base still goes optically black, but the extra headroom
     lets the eroded shelf relief above modulate what you see instead of every
     base sample slamming into the same saturated optical depth. */
  ramp = mix(ramp, ramp * mix(1.95, 0.60, sat(h * 1.25)), uAnvil * 0.85);

  // fade the deck out toward the far cut so it dissolves into haze
  float far = 1.0 - smoothstep(uMaxDist * 0.58, uMaxDist * 0.99, t);

  /* Beyond ~10 km the ragged fringe of a cloud field is thinner than a pixel,
     and a lone eroded wisp lit by the forward-scattering lobe renders as a
     bright speck that reads as sensor dust rather than weather. Past that
     range keep only well-formed cloud bodies. */
  float bodyGate = mix(1.0, smoothstep(0.08, 0.40, coverage),
                       smoothstep(11000.0, 28000.0, t));

  return d * uDensityMul * ramp * far * bodyGate;
}
`;

/* ------------------------------------------------------------ raymarch */

export const MARCH_FRAG = COMMON + /* glsl */ `
varying vec2 vUv;

uniform vec3  uSunDir;
uniform vec3  uSunColor;      // sunColor * sunIntensity, linear
uniform vec3  uMoonDir;
uniform vec3  uMoonColor;
uniform vec3  uSkyColor;      // ambient from above, linear radiance
uniform vec3  uGroundColor;   // bounce from below, linear radiance
uniform vec3  uHazeColor;     // horizon in-scatter radiance
uniform vec3  uHazeZenith;    // zenith in-scatter radiance

uniform float uFrame;
uniform vec2  uJitter;

uniform float uAerial;        // atmospheric extinction for the cloud layer
uniform float uSteps;
uniform float uSunScatter;    // gain on the direct multiple-scattering term
uniform float uAmbScatter;    // gain on the sky/ground ambient term
uniform float uPowder;        // powdered-sugar strength
uniform float uCirrusHi;      // second, higher cirrostratus shell amount
uniform float uMidDeck;       // mid-level altocumulus shell amount

uniform float uShaft;         // 0..1 precipitation shaft strength
uniform float uGroundY;       // world height the shafts land on

uniform float uFlash;
uniform vec3  uFlashPos;
uniform float uBolt;          // 0..1 visibility of the drawn bolt
uniform vec3  uBoltA;         // bolt top (in cloud)
uniform vec3  uBoltB;         // bolt bottom (ground)

${DENSITY_GLSL}

const vec3 KERNEL[4] = vec3[4](
  vec3( 0.38,  0.35,  0.86), vec3(-0.66,  0.53,  0.53),
  vec3(-0.72, -0.05, -0.69), vec3( 0.48, -0.60,  0.64)
);

/*
 * Cone light march. Four cone taps plus one long tap.
 *
 * Every tap is a full density evaluation, and the taps only get skipped when
 * they leave the shell — which happens immediately when the sun is high and
 * NEVER when it is low, because a near-horizontal ray stays inside the slab
 * indefinitely. That is why golden_hour cost 22 ms while high_noon cost 12
 * with an identical deck. The early-out below fixes exactly that case: once
 * the sample is optically dark to the sun, more taps cannot change the answer.
 */
float lightMarch(vec3 wp, float t, float jit) {
  float od = 0.0;
  /* DISTANCE-ADAPTIVE CONE.
     Extending the march's reach from 17 km to 50 km multiplied the number of
     IN-CLOUD samples (a near-horizon ray now runs tangentially through the deck
     for tens of kilometres), and every one of those pays a five-tap cone here —
     ~20 texture fetches. Measured: high_noon_desert went 9.5 -> 20.1 ms GPU.
     But a cloud 15 km out is a few dozen pixels tall; the fine structure of its
     self shadowing is invisible at that scale and only the top-bright /
     base-dark gradient survives. So the far field gets two long taps instead of
     four short ones — same total path length, half the fetches — and the near
     field, which is what the eye actually reads, is untouched. */
  float farK = sat((t - 8000.0) / 11000.0);
  float st = mix(44.0, 210.0, farK);
  int taps = farK > 0.92 ? 1 : (farK > 0.55 ? 2 : 4);
  vec3 p = wp;
  // weight of the faintest multiple-scattering octave; see the early-out below
  float aMin = mix(0.30, 0.58, uAnvil); aMin *= aMin;
  for (int i = 0; i < 4; i++) {
    if (i >= taps) break;
    p += uSunDir * st + KERNEL[i] * (st * 0.45 * (float(i) + jit));
    float alt = length(vec3(p.x, p.y + Rg, p.z)) - Rg;
    float hf = (alt - uHB) / (uHT - uHB);
    if (hf > 0.0 && hf < 1.0) od += cloudDensity(p, hf, t, false) * st;
    st *= 2.15;
    /* Early-out, but against the SMALLEST multiple-scattering octave, not the
       primary one. Cutting at od*sigma > 4 looks free — the primary octave is
       already dead — and it is not: the loop below evaluates exp(-od*sigma*a)
       with a falling to aMin, so a truncated od leaves the tail octaves at tau
       ~1.3 instead of ~7 and a ten-kilometre thunderhead renders PALE GREY.
       That regression cost a whole iteration. Gate on the tail and the result
       is exact to within exp(-6) while still skipping most of the cone inside
       a dense cell — which is where the golden-hour cost lives, because a low
       sun means no tap ever leaves the shell to be skipped. */
    if (od * uSigma * aMin > 6.0) return od;
  }
  // one long sample catches distant self shadowing (anvils, towers)
  {
    vec3 lp = wp + uSunDir * 3000.0;
    float alt = length(vec3(lp.x, lp.y + Rg, lp.z)) - Rg;
    float hf = (alt - uHB) / (uHT - uHB);
    if (hf > 0.0 && hf < 1.0) od += cloudDensity(lp, hf, t, false) * 1500.0;
  }
  return od;
}

/** Henyey-Greenstein, normalised so 1.0 == isotropic. */
float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}
/** Dual lobe: strong forward silver lining + a gentle back lobe. */
float dualPhase(float c, float k) {
  float f = min(phaseHG(c, 0.74 * k), 7.0);
  float b = phaseHG(c, -0.36 * k);
  return mix(f, b, 0.28);
}

/* -------------------------------------------------------------------------
 *  HIGH CIRRUS — two analytic shells at different altitudes with different
 *  drift rates. Two, not one, on purpose: a single high sheet reads as a
 *  texture pasted on the dome, whereas two that slide past each other at
 *  7.4 km and 10.6 km give the top of the sky the same parallax the cumulus
 *  deck has, and that is what makes a sky read as deep. Costs six texture
 *  fetches for the whole pixel, not per step.
 * ------------------------------------------------------------------------ */
vec4 cirrusShell(vec3 ro, vec3 rd, float cosT, float alt, float amount,
                 float drift, float aniso, float tone) {
  /* Within ~10 degrees of the horizon the shell intersection runs out to a
     couple of hundred kilometres, so a one-pixel change in view direction
     moves the sample point kilometres and the deck shreds into stair-stepped
     shards that read as a rendering bug. Cut it off well before that. */
  if (amount < 0.012 || rd.y <= 0.026) return vec4(0.0);
  vec2 hit = raySphere(ro, rd, Rg + alt);
  float t = hit.y;
  if (t <= 0.0 || t > 170000.0) return vec4(0.0);
  vec3 p = uCamPos + rd * t - uAdvect * drift;
  // fibres run ALONG the wind, so build the sample basis from the wind vector
  vec2 wd = uWindDir;
  vec2 q = vec2(dot(p.xz, wd), dot(p.xz, vec2(-wd.y, wd.x)));
  /* DOMAIN WARP. The sample basis below is 5.6:1 anisotropic, so without a
     warp it walks the shape volume along one axis and the Worley cells line up
     into a regular comb — high_noon_desert renders its cirrus as a set of
     evenly spaced parallel diagonal scanlines, which reads as a shader bug
     rather than as ice cloud. Displacing the along-wind coordinate by a very
     low-frequency field breaks the periodicity without softening the fibres. */
  float warp = texture(uShape, vec3(q.x * 0.0000058, 0.77, q.y * 0.0000071)).b;
  q.x += (warp - 0.5) * 34000.0;
  q.y += (warp - 0.5) * 9000.0;
  vec3 sp = vec3(q.x * 0.0000205 * aniso, 0.213 + alt * 1e-5, q.y * 0.000115 * aniso);
  float n1 = texture(uShape, sp).r;
  float n2 = texture(uShape, sp * 2.4 + 0.317).r;
  vec3 sp3 = vec3(q.x * 0.000062 + q.y * 0.000021, 0.61, q.y * 0.000068);
  float n3 = texture(uShape, sp3).g;
  float f = sat(n1 * 0.62 + n2 * 0.30 + n3 * 0.26 - 0.12);

  /* THRESHOLD. Pass 3 asked for f > 1.06 - 1.15*amount; with the weather
     system's fair-weather cirrus of 0.26 that is f > 0.76, and this field's
     mean is 0.65 with a spread of about 0.2 — so the entire high deck was
     mathematically unreachable and every "clear" sky in the set had a
     completely bare upper half. Re-centred on the field's real histogram. */
  float lo = 0.72 - amount * 0.42;
  float hi = 0.94 - amount * 0.30;
  float a = sat(remap(f, lo, hi, 0.0, 1.0));
  // large-scale mask so the deck occupies part of the sky, not all of it
  float mask = sat(remap(texture(uWeather, p.xz * 0.0000135 + 0.21).g, 0.26, 0.72, 0.0, 1.0));
  a *= mix(0.10, 1.0, mask);
  if (a <= 0.002) return vec4(0.0);
  a *= smoothstep(0.028, 0.30, rd.y) * 1.05 * (1.0 - smoothstep(60000.0, 150000.0, t));

  float ext = exp(-t * uAerial * 0.85);
  /* Ice cloud: forward-scattering, almost no self shadowing, so it is bright
     where it is between you and the sun and pale grey elsewhere. */
  vec3 col = uSunColor * (0.24 + 0.85 * pow(sat(cosT), 7.0)) * (0.42 * tone)
           + uSkyColor * 0.95;
  col = mix(mix(uHazeColor, uHazeZenith, sat(rd.y * 1.7))
              * (0.85 + 0.7 * pow(sat(cosT), 4.0)), col, ext);
  return vec4(col, a * mix(0.25, 1.0, ext));
}

/* ---------------------------------------------------------------------------
 *  ALTOCUMULUS — the missing middle layer.
 *
 *  The deck had cumulus at 1-4 km and cirrus at 7.4/10.6 km and nothing at all
 *  between them, so every sky was two features deep. A real one is four or
 *  five, and the parallax between layers moving at different rates is what
 *  makes a sky read as a volume rather than as a texture on the inside of a
 *  dome — the brief's "clear depth between layers".
 *
 *  One analytic shell, ~4 texture fetches for the WHOLE pixel (not per march
 *  step), so it costs a rounding error next to the volume march. Unlike the
 *  cirrus it is thick enough to have a base, so it carries a real Beer term
 *  plus the powder darkening and goes cool grey underneath while its sunward
 *  face lights — which is exactly the read the golden-hour sky is missing.
 * ------------------------------------------------------------------------ */
vec4 midShell(vec3 ro, vec3 rd, float cosT, float alt, float amount, float drift) {
  if (amount < 0.015 || rd.y <= 0.034) return vec4(0.0);
  vec2 hit = raySphere(ro, rd, Rg + alt);
  float t = hit.y;
  if (t <= 0.0 || t > 150000.0) return vec4(0.0);
  vec3 p = uCamPos + rd * t - uAdvect * drift;

  vec4 s = texture(uShape, vec3(p.x, alt * 0.62, p.z) * 0.00030);
  float f = s.r * 0.60 + s.g * 0.28 + s.b * 0.17;
  // mackerel: a broken sheet of small cells, not a continuous veil
  float cell = texture(uDetail, vec3(p.x, alt * 2.1, p.z) * 0.00125).g;
  float mask = sat(remap(texture(uWeather, p.xz * 0.0000165 + 0.71).b,
                         0.22, 0.78, 0.0, 1.0));
  float a = sat(remap(f - cell * 0.36, 0.66 - amount * 0.34,
                      0.97 - amount * 0.22, 0.0, 1.0));
  a *= mix(0.04, 1.0, mask);
  if (a <= 0.003) return vec4(0.0);
  a *= smoothstep(0.036, 0.24, rd.y)
     * (1.0 - smoothstep(46000.0, 130000.0, t)) * amount;
  if (a <= 0.002) return vec4(0.0);

  float tau = a * 6.0;
  float lit = exp(-tau);
  float powder = 1.0 - exp(-2.4 * tau);
  vec3 col = uSunColor * (0.045 + 0.60 * lit * powder)
               * mix(1.0, dualPhase(cosT, 0.72), 0.60) * 0.40
           + uSkyColor * (0.26 + 0.55 * lit) * 0.80
           + uGroundColor * 0.38;
  float ext = exp(-t * uAerial);
  col = mix(mix(uHazeColor, uHazeZenith, sat(rd.y * 1.7))
              * (0.9 + 0.7 * pow(sat(cosT), 5.0)), col, ext);
  return vec4(col, sat(a));
}

/* ---------------------------------------------------------------------------
 *  PRECIPITATION SHAFTS
 *  A short, cheap march through the sub-cloud layer. Density is driven by the
 *  same weather field that decides where the heavy cells are, so the curtains
 *  hang under the darkest part of the deck and streak downwind.
 * ------------------------------------------------------------------------- */
vec4 rainShafts(vec3 rd, float cosT, float maxT, float ign) {
  if (uShaft < 0.01) return vec4(0.0);
  float base = uHB;
  float tTop = rd.y > 0.002 ? (base - uCamPos.y) / rd.y : 1.0e9;
  float tEnd = min(min(maxT, tTop), 26000.0);
  if (tEnd <= 40.0) return vec4(0.0);

  const int N = 12;
  float stepLen = tEnd / float(N);
  float t = stepLen * (0.25 + ign * 0.7);
  vec3 acc = vec3(0.0);
  float T = 1.0;

  for (int i = 0; i < N; i++) {
    vec3 wp = uCamPos + rd * t;
    float hAbove = wp.y - uGroundY;
    if (hAbove > 0.0) {
      vec3 sp = wp - uAdvect * 0.55;
      sp.xz -= uWindDir * (base - wp.y) * 0.28;
      float cell = texture(uWeather, sp.xz * uWeatherScale * 0.62).b;
      cell = sat(remap(cell, 0.42 - uShaft * 0.30, 0.86, 0.0, 1.0));
      float st = texture(uShape, vec3(sp.x * 0.00042 + uTime * 0.004,
                                      sp.y * 0.00004,
                                      sp.z * 0.00042)).g;
      cell *= 0.45 + st * 1.15;
      /* DISTANCE GATE, and it has to be a long one.
         This is where storm_plains' "brushed metal sky" actually came from —
         not from the cloud field, which is why four separate density-side fixes
         changed the frame by literally nothing. A storm base sits at 700 m and
         the camera at 52 m, so EVERY ray in the frame, right up to the top
         corner, is "under the cloud base and within 700 m of the ground": the
         old 450 m gate let this 2D-ish curtain pattern paint itself across the
         entire sky, and against a near-black Cb base a dim veil reads as bright
         sinuous ribbons. A shaft only reads as a shaft when it is kilometres
         away and you can see the whole column; the near field is the particle
         rain's job. */
      float prof = smoothstep(-40.0, 190.0, hAbove)
                 * (1.0 - smoothstep(base * 0.55, base * 0.95, hAbove))
                 * smoothstep(2200.0, 7000.0, t);
      float dens = cell * cell * prof * uShaft * 2.0e-4;
      if (dens > 1e-7) {
        float tr = exp(-dens * stepLen);
        /* A rain curtain is DARKER than the horizon it hangs in front of: it
           sits in the shadow of the cell producing it, so all it gets is the
           skylight that leaks in from the sides. */
        vec3 L = mix(uHazeColor, uHazeZenith, 0.35)
                 * (0.34 + 0.30 * pow(sat(cosT), 3.0))
               + uSunColor * 0.028 * pow(sat(cosT), 6.0);
        acc += T * L * (1.0 - tr);
        T *= tr;
      }
    }
    t += stepLen;
  }
  return vec4(acc, 1.0 - T);
}

/* -------------------------------------------------------------------------
 *  LIGHTNING BOLT — a screen-space distance field against the world-space
 *  segment uBoltA..uBoltB, jittered into a forked channel. Additive.
 * ------------------------------------------------------------------------ */
vec3 boltGlow(vec3 ro, vec3 rd) {
  if (uBolt < 0.002) return vec3(0.0);
  vec3 ab = uBoltB - uBoltA;
  vec3 w0 = ro - uBoltA;
  float a = dot(rd, rd), b = dot(rd, ab), c = dot(ab, ab);
  float d = dot(rd, w0), e = dot(ab, w0);
  float den = a * c - b * b;
  if (abs(den) < 1e-4) return vec3(0.0);
  float s = (b * e - c * d) / den;         // along the view ray
  float u = (a * e - b * d) / den;         // along the bolt
  if (s <= 0.0) return vec3(0.0);
  u = clamp(u, 0.0, 1.0);
  vec3 axis = normalize(ab);
  vec3 sideA = normalize(cross(axis, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
  vec3 sideB = cross(axis, sideA);
  vec3 pOnRay = ro + rd * max(s, 0.0);

  float w1 = (texture(uShape, vec3(u * 2.7, 0.53, 0.21)).r - 0.5)
           + (texture(uShape, vec3(u * 9.0, 0.11, 0.77)).g - 0.5) * 0.55
           + (texture(uShape, vec3(u * 23.0, 0.61, 0.33)).b - 0.5) * 0.28;
  float w2 = (texture(uShape, vec3(u * 3.3, 0.19, 0.71)).g - 0.5)
           + (texture(uShape, vec3(u * 12.0, 0.83, 0.09)).r - 0.5) * 0.55;
  float kink = 150.0 * (0.20 + u * 1.15);
  vec3 pOnBolt = uBoltA + ab * u + sideA * w1 * kink + sideB * w2 * kink * 0.8;

  float dist = length(pOnRay - pOnBolt);
  float dd = max(length(pOnBolt - ro), 1.0);
  float rad2 = 13.0 * 13.0 + dd * dd * 2.4e-5;
  float core = exp(-dist * dist / rad2);
  float halo = exp(-dist / (150.0 + dd * 0.022));
  float taper = (1.0 - smoothstep(0.62, 1.0, u) * 0.55) * (0.55 + 0.45 * smoothstep(0.0, 0.12, u));

  float fu = clamp((u - 0.42) / 0.58, 0.0, 1.0);
  vec3 pFork = uBoltA + ab * (0.42 + fu * 0.58)
             + sideA * (w1 * kink * 0.6 + fu * 260.0)
             + sideB * (w2 * kink * 0.5 - fu * 140.0);
  float fdist = length(pOnRay - pFork);
  float fcore = exp(-fdist * fdist / (rad2 * 1.6)) * (1.0 - fu * 0.55) * step(0.42, u);

  return (vec3(1.45, 1.58, 2.0) * (core * 30.0 + fcore * 11.0)
        + vec3(0.75, 0.86, 1.25) * halo * 0.9)
         * uBolt * taper;
}

void main() {
  vec3 rd = rayDir(vUv, uJitter);
  vec3 ro = vec3(uCamPos.x, uCamPos.y + Rg, uCamPos.z);
  float camAlt = length(ro) - Rg;
  float cosT = dot(rd, uSunDir);

  vec3 scatter = vec3(0.0);
  float T = 1.0;

  vec2 inner = raySphere(ro, rd, Rg + uHB);
  vec2 outer = raySphere(ro, rd, Rg + uHT);

  float tStart = -1.0, tEnd = -1.0;
  if (camAlt < uHB) {
    if (rd.y > 0.0005 && inner.y > 0.0) { tStart = inner.y; tEnd = outer.y; }
  } else if (camAlt < uHT) {
    tStart = 0.0;
    tEnd = (inner.x > 0.0) ? inner.x : outer.y;
  } else {
    if (outer.y > 0.0) { tStart = max(outer.x, 0.0); tEnd = (inner.x > 0.0) ? inner.x : outer.y; }
  }

  // interleaved gradient noise dither so banding turns into film grain that
  // the temporal pass then eats
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uFrame * 5.588238,
                                           vec2(0.06711056, 0.00583715))));

  if (tEnd > tStart && tStart >= 0.0) {
    tEnd = min(tEnd, tStart + uMaxDist);
    float span = tEnd - tStart;
    int steps = int(uSteps);
    /* Cap the step hard. Empty space is strided over at 2.7x, and that is
       where nearly all the steps go, so the cost of a short in-cloud step is
       small and the banding disappears. */
    float baseStep = clamp(span / float(steps), 30.0, 112.0);

    float t = tStart + baseStep * ign;
    bool inCloud = false;

    for (int i = 0; i < MAXSTEPS; i++) {
      /* Transmittance cut-off 0.030 -> 0.055. Below 5.5 % transmittance a
         further sample can change the composited pixel by at most 5.5 % of its
         own radiance, and it is being written under a bilateral upsample and a
         temporal resolve that are both averaging neighbours anyway. Measured:
         invisible in a difference of the ten shots, and it is the cheapest
         place to pay for the wider coverage window, because the samples it
         skips are the deep-interior ones that each cost a five-tap cone. */
      if (i >= steps || t > tEnd || T < 0.055) break;
      vec3 wp = uCamPos + rd * t;
      float alt = length(vec3(wp.x, wp.y + Rg, wp.z)) - Rg;
      float hf = (alt - uHB) / (uHT - uHB);

      float dens = 0.0;
      if (hf > 0.0 && hf < 1.0) dens = cloudDensity(wp, hf, t, true);

      /* THE STEP GROWS GEOMETRICALLY WITH DISTANCE.
         58 steps of a 112 m base stridden at 2.7x reach 17.5 km, and at 17 km a
         cloud deck is still well above the horizon — which is why every one of
         our skies has cumulus in the upper third and bare haze along the
         horizon, the exact inverse of the perspective a real cumulus field has,
         where cells crowd and shrink into a dense horizon band. That missing
         convergence is a large part of why the deck reads as wallpaper rather
         than as something with depth in it.
         A ray's angular footprint grows linearly with t, so the sample spacing
         is allowed to as well. The same 58 steps now reach past 60 km for NO
         extra samples, and cloudDensity's LOD/bodyGate terms have already
         converged the far field to smooth bodies so it cannot alias. */
      /* TWO GROWTH RATES, and conflating them was a real defect.
         Striding faster through EMPTY space is free — nothing is being
         integrated, so the only thing the stride length costs is the precision
         with which a cloud's leading surface is located, and the back-up on
         entry already fixes that. Striding faster through CLOUD is not free: it
         is a quadrature step, and at 380 m through a 1 km puff you are
         integrating three samples and the iso-t surfaces project as concentric
         contour rings across the silhouette. That is exactly what the first cut
         of this rendered — visible terracing on every golden-hour cumulus, made
         worse because the tightened reconstruction filter no longer averages
         the sample noise away.
         So the empty stride keeps the full geometric growth (which is what
         buys the 50 km reach), and the in-cloud step is capped. */
      float grow = 1.0 + t * 0.00034;
      float growIn = min(grow, 1.9);

      if (dens > 0.0 && !inCloud) {
        /* We have just walked into a cloud with a COARSE empty-space stride,
           so the surface we are about to start integrating from is quantised
           to that stride — which draws hard horizontal layers across every
           puff, because iso-t surfaces project as bands. Back up to the last
           known-empty sample and re-enter at the fine rate. */
        inCloud = true;
        t = max(tStart, t - baseStep * 1.8 * grow);
        continue;
      }

      if (dens > 0.0) {
        /* Step scales with distance: the near field gets fine integration
           where the eye can see the gradient, the far field is strided over
           because it is a few pixels tall anyway. */
        float stepLen = baseStep * mix(0.72, 1.30, sat(t / 9000.0)) * growIn;

        /* PERF. Widening the margins multiplied the number of very-low-density
           samples, and each one was paying a five-tap cone light march to learn
           that it is barely shadowed. Below 0.035 the sample transmits >97 % of
           the sun no matter what the cone finds, so estimate it analytically.
           This is where most of the golden-hour cost went: at a low sun the
           cone taps never leave the shell, so none of them could be skipped. */
        /* THE SHORTCUT IS ONLY VALID WHERE THERE IS NOTHING OVERHEAD.
           It assumes a thin sample is thin all the way to the sun — true for a
           fair-weather fringe, and catastrophically false for the ragged scud
           hanging under a thunderstorm base, which is thin in itself but sits
           in the shadow of ten kilometres of cumulonimbus. Ungated, every wisp
           under the storm deck was lit as though it were floating in clear
           midday air: storm_plains rendered a bright silvery-white ceiling that
           read as a nice breezy afternoon rather than as weather. Convective
           decks always pay for the real cone march — storm_plains has 10 ms of
           headroom and this is exactly what to spend it on. */
        float od = (dens < 0.035 && uAnvil < 0.25)
                 ? dens * 1300.0 : lightMarch(wp, t, ign);

        /* --- multiple scattering approximation (3 octaves) -------------
           Frostbite-style: each octave halves extinction, energy and phase
           eccentricity, a cheap stand-in for light that has already bounced a
           few times inside the cloud. This is what gives soft interiors and
           the glow that leaks THROUGH a backlit margin. */
        float sunE = 0.0;
        float a = 1.0, b = 1.0, c = 1.0, wsum = 0.0;
        // powdered sugar: thin edges facing away from the sun go dark
        float powderMix = uPowder * sat(0.5 - cosT * 0.5);
        for (int n = 0; n < 3; n++) {
          float tau = od * uSigma * a;
          float beer = exp(-tau);
          /* Beer-Powder: exp(-d) * (1 - exp(-2d)). A DARKENING of low-density
             regions, which is what gives a cumulus its crisp dark shoulder
             against a bright sky. */
          float powder = 1.0 - exp(-2.0 * tau);
          float e = beer * mix(1.0, powder, powderMix);
          // the phase only modulates part of the energy: an optically thick
          // cloud face is near-Lambertian, so a raw HG lobe would make every
          // cloud not lined up with the sun read as dirty grey
          /* THE PHASE WEIGHT HAS TO FALL WITH OPTICAL DEPTH, and holding it at a
             constant 0.62 is a large part of why every cloud not lined up with
             the sun rendered as a grey wad.
             dualPhase() is normalised so 1.0 == isotropic, and at 90 degrees off
             the sun it returns ~0.15 — so a constant 0.62 weight multiplied the
             ENTIRE direct term by 0.47 for every cloud in the side-lit half of
             the sky, at noon that is most of them. Physically the anisotropy
             belongs to light that has scattered ONCE: by the time a photon has
             been through an optically thick cell its direction is randomised and
             the emergent radiance is near-Lambertian. So the weight now tracks
             this octave's own optical depth — a translucent fringe keeps the
             full forward lobe and the silver lining with it, a thick body goes
             isotropic and stays white. */
          float phaseW = mix(0.62, 0.16, sat(tau * 0.55));
          sunE += b * e * mix(1.0, dualPhase(cosT, c), phaseW);
          wsum += b;
          /* The tail octaves are light that has bounced many times. In a fair
             cumulus that is what stops the shaded side reading as a black
             slab; in a 10 km thunderhead it is physically almost gone, and
             leaving it in is exactly why a storm deck renders as bright grey
             instead of a dark lid. */
          /* PASS 11: the fair-weather tail weight goes 0.46 -> 0.60. These
             octaves ARE the light that has bounced several times inside the
             cloud, and they are the only thing lighting a face the sun does not
             reach directly. At 0.46, with sigma back in the physical band, a
             cumulus seen side-on at noon had a first octave of exactly zero and
             a tail too weak to replace it, so the body of every puff rendered
             darker than its own fringe — a grey wad with a bright rim, which is
             the inverse of how a cumulus reads. The storm end is untouched:
             a Cb genuinely has no tail left by the time light reaches its base. */
          a *= mix(0.30, 0.58, uAnvil); b *= mix(0.60, 0.26, uAnvil); c *= 0.55;
        }
        sunE /= max(wsum, 1e-3);

        /* ----------------------------------------- DEEP-SCATTERING FLOOR
           WHY A CUMULUS IS WHITE, and the term the three-octave approximation
           cannot express.

           Cloud droplets have a single-scattering albedo of ~0.9999 in the
           visible: light that enters a cloud is essentially never absorbed, it
           is only redirected, and a kilometre-thick cell therefore reaches a
           diffuse equilibrium with a reflectance around 0.7-0.9. That is the
           whole reason a fair-weather cumulus reads as WHITE from every angle
           including its base.

           The truncated octave sum cannot produce that. Each octave is a Beer
           term, and Beer describes ABSORPTION; with only three of them the
           deepest still decays as exp(-0.09*tau) and a sample whose cone
           optical depth is 6-7 — which is any sample more than a couple of
           hundred metres inside a cell — lands at sunE ~ 0.14. Measured
           against pass 9 that is what put a grey wad in the middle of
           high_noon_desert while the small thin puffs around it stayed white:
           the defect scales with cell size, because od does.

           This adds the diffusion limit as a floor: an energy that falls only
           very slowly with depth for a non-convective cloud (the light is
           bouncing, not being consumed) and quickly for a cumulonimbus, where
           the path is genuinely long enough for the small absorption and the
           precipitation-sized drops to matter. It is the same shape as a fourth
           octave with a very low extinction and a high weight, written as a
           floor so it can never darken anything.

           CALIBRATION, and the first cut of this got it wrong in an instructive
           way. At a decay of 0.028 per unit tau the floor was still 0.72 of its
           peak at tau = 12, which is what a GRAZING sun gives you: at golden
           hour the cone march runs near-horizontally and stays inside the deck
           for a kilometre or more, so every sample in the cloud — including the
           whole anti-sun side — got the same near-full floor. golden_hour_vista
           rendered its cumulus as a flat lozenge of orange with the red channel
           pinned at 251 +/- 2 and a hard scalloped edge, i.e. the pass-3 "solid
           amoeba" arriving by a new route. The floor has to keep FALLING, just
           much more slowly than a Beer term: fitted so a fair cumulus base at
           noon (tau ~ 6) lands near 0.29 and a back-lit margin at golden hour
           (tau ~ 12) lands near 0.10, which is the dark-body-with-bright-rim
           read a low sun is supposed to give. */
        float msFloor = mix(0.62, 0.04, uAnvil)
                      * exp(-od * uSigma * mix(0.115, 0.40, uAnvil));
        sunE = max(sunE, msFloor);

        vec3 L = uSunColor * (sunE * uSunScatter);

        /* Moon: the SAME multiple-scattering treatment, not a raw Beer term.
         * With a single exp(-tau) the thick core goes to pure black while its
         * thin fringe stays bright. Light that has bounced a few times inside
         * the cloud is what fills the core in, and at night it is ALL you see. */
        float mcos = dot(rd, uMoonDir);
        float moonE = 0.0;
        {
          float ma = 1.0, mb = 1.0, mc = 1.0, mw = 0.0;
          for (int n = 0; n < 2; n++) {
            float mt = od * uSigma * ma * 0.7;
            moonE += mb * exp(-mt) * mix(1.0, dualPhase(mcos, mc), 0.62);
            mw += mb;
            ma *= 0.30; mb *= 0.45; mc *= 0.55;
          }
          moonE /= max(mw, 1e-3);
        }
        L += uMoonColor * moonE * uSunScatter * 0.42;

        /* --- ambient: sky above, warm bounce below, dark storm bases ---
         *
         * Skylight enters a cloud through its TOP and is extinguished on the
         * way down, so the mass above a sample decides how dark its base is.
         * For a ten-kilometre thunderhead the answer is "black": a Cb base
         * receives essentially no skylight and is lit only by ground bounce
         * and light leaking in from the sides. That flat dark lid with bright
         * cauliflower shoulders above it IS the storm. */
        /* THIS TERM IS WHY OUR CLOUDS HAD NO VERTICAL MODELLING.
           The quantity is already an optical depth, and it was pushed through
           sat(above * 0.0055) — so the term needed tau = 182 before it even
           saturated. A fair-weather cumulus (sigma 0.026, 3.5 km shell, local
           density 0.6) runs tau ~ 55 at its base, which the old curve mapped to
           0.57: its base kept well over half the skylight its top got and the
           whole puff came out at ONE tonal value. Measured on the golden-hour
           capture, the sky's 1st-to-99th percentile luma spanned 0.38-0.89 with
           a local 8 px contrast of 0.012, against 0.024-0.031 in the reference
           frames — flat bright paint, exactly the "no internal density" verdict.

           The physics is diffusion, not a straight Beer term: skylight entering
           the top scatters many times on the way down, so the falloff goes as
           exp(-k*sqrt(tau)) rather than exp(-tau). Calibrated so a fair cumulus
           base keeps 0.15 of full skylight and a 10 km thunderhead base keeps
           ~0.001. Ground bounce is the mirror image — it enters through the
           BASE, so it lights the underside fully and dies before the top, which
           is what makes an evening cloud warm underneath and cool on top. */
        /* PASS 11 — THE DIFFUSION CONSTANT IS NOT ONE NUMBER.
           0.27 was calibrated on the case it was written for, a ten-kilometre
           thunderhead whose base genuinely receives no skylight. Applied
           unconditionally it also took a 3.5 km fair-weather cumulus base down
           to 0.15 of the skylight its top gets, and 0.15 of a cool zenith is
           not a soft grey underside, it is a hole: measured against pass 9,
           high_noon_desert's cumulus went from white cauliflower with a faint
           blue-grey shading on the underside to grey-bottomed wads, and
           golden_hour's deck lost its warmth entirely. A real fair-weather
           cumulus base is bright — it is the single most-quoted fact about
           them — because a 1-2 km cloud is nowhere near optically deep enough
           to shut skylight out.
           So the constant is now interpolated by uAnvil: a fair cumulus base
           keeps ~0.33, a Cb base still goes to ~0.001. Same for the lateral
           term. This is the single biggest contributor to the "grey-bottomed
           cotton wad" regression. */
        float kdif = mix(0.150, 0.30, uAnvil);
        float thick = dens * uSigma * (uHT - uHB);
        float skyReach = exp(-kdif * sqrt(max(thick * (1.0 - hf), 0.0)));
        float gndReach = exp(-kdif * sqrt(max(thick * hf, 0.0)));
        vec3 amb = uSkyColor * skyReach * mix(0.42, 1.0, sat(hf * 1.6 + 0.14))
                 + uGroundColor * gndReach * mix(1.0, 0.26, sat(hf * 1.5));
        // skylight cannot reach the middle of a thick cloud laterally either
        amb *= mix(1.0, mix(0.52, 0.24, uAnvil), sat(od * uSigma * 0.14));
        L += amb * uAmbScatter;

        /* --- lightning lights the cloud from the inside ---------------- */
        if (uFlash > 0.001) {
          float fd = length(wp - uFlashPos);
          L += vec3(7.0, 7.4, 9.0) * uFlash * exp(-fd * 0.00085);
        }

        /* --- aerial perspective, applied per sample -------------------- */
        float ext = exp(-t * uAerial);
        vec3 haze = mix(uHazeColor, uHazeZenith, sat(rd.y * 1.7))
                  * (0.9 + 0.7 * pow(sat(cosT), 5.0));
        L = L * ext + haze * (1.0 - ext);

        float tr = exp(-dens * uSigma * stepLen);
        scatter += T * L * (1.0 - tr);
        T *= tr;
        t += stepLen;
      } else {
        t += baseStep * 2.6 * grow;
        inCloud = false;
      }
    }
  }

  /* Layers above whatever the main march produced, nearest first. The drift
     rates fall with altitude on purpose: four decks sliding past each other at
     four rates is the parallax that makes the sky read as deep. */
  vec4 mc = midShell(ro, rd, cosT, 5200.0, uMidDeck, 1.9);
  scatter += T * mc.rgb * mc.a;
  T *= (1.0 - mc.a);

  vec4 c1 = cirrusShell(ro, rd, cosT, 7400.0,  uCirrus,   2.6, 1.00, 1.00);
  scatter += T * c1.rgb * c1.a;
  T *= (1.0 - c1.a);
  vec4 c2 = cirrusShell(ro, rd, cosT, 10600.0, uCirrusHi, 1.3, 0.62, 0.78);
  scatter += T * c2.rgb * c2.a;
  T *= (1.0 - c2.a);

  /* precipitation shafts hang BELOW the deck, so they composite in front */
  float cloudT = T;
  vec4 sh = rainShafts(rd, cosT, (tStart > 0.0 ? tStart : 40000.0), ign);
  scatter = sh.rgb + (1.0 - sh.a) * scatter;
  T = cloudT * (1.0 - sh.a);

  /* the bolt is in front of its own cell but behind nothing else */
  scatter += boltGlow(uCamPos, rd);

  gl_FragColor = vec4(scatter, 1.0 - T);
}
`;

/* --------------------------------------------------------- shadow map */

/**
 * Top-down cloud shadow. One texel per patch of ground; march the sun ray
 * upward through the shell and record how much direct sunlight survives.
 * Moving cloud shadow across a landscape is the strongest cheap realism cue
 * there is, and at high noon it is the only thing that keeps a flat plain from
 * reading as evenly-lit cardboard.
 */
export const SHADOW_FRAG = COMMON + /* glsl */ `
varying vec2 vUv;
uniform vec3  uSunDir;
uniform vec4  uShadowArea;   // xy = centre XZ, z = half extent, w = ray-origin Y
uniform float uShadowSoft;

${DENSITY_GLSL}

void main() {
  vec2 wxz = uShadowArea.xy + (vUv * 2.0 - 1.0) * uShadowArea.z;
  vec3 p0 = vec3(wxz.x, uShadowArea.w, wxz.y);

  if (uSunDir.y < 0.02 || uCoverage < 0.02) { gl_FragColor = vec4(1.0); return; }

  // enter/exit of the shell along the sun ray
  float t0 = (uHB - p0.y) / uSunDir.y;
  float t1 = (uHT - p0.y) / uSunDir.y;
  if (t1 <= 0.0) { gl_FragColor = vec4(1.0); return; }
  t0 = max(t0, 0.0);

  const int N = 9;
  float stepLen = (t1 - t0) / float(N);
  float od = 0.0;
  /* One step of dither so the 9 samples do not band. Each sample is worth a
     ninth of the whole shell traversal, so re-rolling this field is not a
     cosmetic change — it visibly restates the shadow. It is therefore keyed to
     a FIXED 16 m world lattice: not to vUv (which re-rolls the instant the map
     scrolls by a texel) and not to the texel grid (which re-rolls whenever the
     footprint changes size). Sine-free hash — the cell index runs to ~1200 and
     sin() at that argument is precision-starved on mobile-class float. */
  vec3 h3 = fract(vec3(floor(wxz * 0.0625).xyx) * 0.1031);
  h3 += dot(h3, h3.yzx + 33.33);
  float jit = fract((h3.x + h3.y) * h3.z);
  float t = t0 + stepLen * jit;
  for (int i = 0; i < N; i++) {
    vec3 wp = p0 + uSunDir * t;
    float hf = (wp.y - uHB) / (uHT - uHB);
    if (hf > 0.0 && hf < 1.0) od += cloudDensity(wp, hf, 3000.0, false) * stepLen;
    t += stepLen;
  }
  /* Clouds are not black: even under a thick cell a good deal of light
     diffuses through, and it arrives blue because it came from the sky. The
     floor matters — with a hard zero, ground under a storm cell loses 100 % of
     its direct light and the plain reads as a silhouette rather than as a
     landscape in shadow. */
  float vis = mix(0.06, 1.0, exp(-od * uSigma * uShadowSoft));
  gl_FragColor = vec4(vis, vis, vis, 1.0);
}
`;

/* ------------------------------------------------------ temporal resolve */

export const RESOLVE_FRAG = COMMON + /* glsl */ `
varying vec2 vUv;

uniform sampler2D uCur;
uniform sampler2D uHist;
uniform mat4  uPrevViewProj;
uniform float uBlend;
uniform float uHistValid;
uniform vec2  uTexel;
uniform float uHB;
uniform float uHT;
uniform vec3  uAdvectDelta;   // metres the deck moved downwind since last frame
uniform float uClampPad;      // sigmas of slack on the variance clip box
uniform float uCurSmooth;     // 3x3 box weight on the fresh sample, 0..1

void main() {
  vec4 cur = texture2D(uCur, vUv);

  if (uHistValid < 0.5) { gl_FragColor = cur; return; }

  /* reproject: intersect the view ray with the middle of the cloud shell and
     project that world point with last frame's view-projection */
  vec3 rd = rayDir(vUv, vec2(0.0));
  vec3 ro = vec3(uCamPos.x, uCamPos.y + Rg, uCamPos.z);
  vec2 hit = raySphere(ro, rd, Rg + (uHB + uHT) * 0.5);
  float t = hit.y > 0.0 ? hit.y : 12000.0;
  t = clamp(t, 400.0, 90000.0);
  /* THE DECK IS MOVING, NOT JUST THE CAMERA.
     Reprojecting the world point with last frame's view-projection is only
     correct for a STATIC world: it answers "where was this point on screen last
     frame", when what the history actually holds is "where was this CLOUD
     FEATURE last frame". Those differ by the wind. With a frozen capture camera
     the camera term is identity, so the resolve was blending a moving cloud
     against a stationary history at 0.92 and the neighbourhood clamp was
     chopping the resulting smear into the horizontal combing visible along
     every downwind cloud margin. The wide reconstruction filter used to hide
     it; once that was tightened it became the most obvious artifact in the sky.
     A feature at P now was at P - windDrift last frame, so undo the drift
     before projecting. This is also what stops the deck smearing under a
     galloping camera, which a human playtester reported. */
  vec3 world = uCamPos + rd * t - uAdvectDelta;

  vec4 cp = uPrevViewProj * vec4(world, 1.0);
  if (cp.w <= 0.0) { gl_FragColor = cur; return; }
  vec2 puv = cp.xy / cp.w * 0.5 + 0.5;
  if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) {
    gl_FragColor = cur; return;
  }

  /* NEIGHBOURHOOD CLAMP — the only thing standing between a 0.92 history and
     the horizontal combing that was visible on every downwind cloud margin in
     six of ten shots.
     ------------------------------------------------------------------------
     WHY THE 4-TAP CROSS WAS NOT ENOUGH. The reprojection above undoes ONE
     wind drift, uAdvectDelta, taken at 0.9x the accumulated advection —
     correct for a feature at the middle of the cumulus shell, because the
     density field samples at wp - uAdvect*(0.70 + hf*0.45) and hf = 0.5
     there. But hf is the HEIGHT FRACTION, so the cirrus deck drifts at 1.15x
     and the shelf base at 0.70x: every pixel that is not mid-shell is
     reprojected with the wrong motion, by up to ±0.22x of the per-frame drift.
     One frame of that is sub-pixel. Twelve frames of it (which is what a 0.92
     blend integrates) is a smear along the wind, and the clamp is what has to
     catch it.
     A 4-tap cross only bounds the history against 5 samples, and it then ADDED
     22% of that range back as slack — so a history mis-registered ALONG the
     wind, which is exactly the horizontal axis, landed inside the padded box
     and survived. A full 3x3 bounds the true local range in every direction
     including the diagonals the wind actually runs on, and the slack drops to
     a small absolute floor that exists only to stop the blue-noise dither of
     the march itself being clamped away (which is what makes blend 0 look like
     a dither pattern instead of a cloud).
     AND WHY MIN/MAX IS STILL NOT ENOUGH AT A MARGIN. Widening the cross to a
     3x3 cleaned the cloud INTERIORS and left the margins combing exactly as
     before, which is the diagnostic: at a silhouette edge the 3x3 straddles
     both sky and cloud, so [mn,mx] spans nearly the full range and the clamp
     bounds nothing. Every pixel of the artifact lives on precisely those
     edges. So the box is built from the first two MOMENTS instead — mean +/-
     uClampPad * sigma, Salvi's variance clipping. At an edge the distribution
     is bimodal and sigma is large but the box is still centred on the local
     mean, so a history smeared one texel downwind falls outside it and is
     rejected; inside a cloud sigma collapses and the box opens up around the
     march's own blue-noise dither, which is what the history is there to
     integrate. Same nine taps, ~10 extra ALU.
     Cost: +4 taps on a 0.45-scale full-screen quad. Measured below 0.1 ms. */
  vec4 m1 = vec4(0.0), m2 = vec4(0.0), mn = cur, mx = cur;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec4 s = texture2D(uCur, vUv + vec2(float(i), float(j)) * uTexel);
      m1 += s; m2 += s * s;
      mn = min(mn, s); mx = max(mx, s);
    }
  }
  vec4 mu = m1 / 9.0;
  vec4 sg = sqrt(max(m2 / 9.0 - mu * mu, vec4(0.0)));
  // Never let the box escape the true local range, and never let it collapse
  // below the dither floor of the march.
  vec4 lo = max(mu - sg * uClampPad, mn) - 0.003;
  vec4 hi = min(mu + sg * uClampPad, mx) + 0.003;

  vec4 h = texture2D(uHist, puv);
  h = clamp(h, lo, hi);

  /* SMOOTH THE FRESH CONTRIBUTION, NOT THE HISTORY.
     ------------------------------------------------------------------------
     Root cause of the combing, established by ablation rather than by eye:
     force uBlend to 0 and the sky is not clean, it is a hard DIAGONAL HATCH.
     That is the interleaved-gradient-noise dither the march uses to offset its
     first step (see MARCH_FRAG: t = tStart + baseStep * ign, with baseStep up
     to 112 m), and IGN is a spatially STRUCTURED 2-3 px pattern, not white
     noise. The temporal pass is supposed to eat it. It cannot: the
     neighbourhood box is built from the current frame, which carries the
     hatch, so the history is re-clamped onto the hatch every frame and never
     converges. Widening the box to 3x3 and then to variance clipping each
     cleaned the cloud interiors and left the margins identical, which is the
     proof that the residual is the FRESH 8% being injected already hatched,
     not a stale history leaking through.
     So the 3x3 mean is spent where it actually helps. mu is already computed
     for the variance box, so this costs one mix. It trades a little acuity on
     a cloud margin — which is a soft gradient to begin with — for the removal
     of a fixed-pattern artifact that was visible in six of ten shots. */
  gl_FragColor = mix(mix(cur, mu, uCurSmooth), h, uBlend);
}
`;

/* ----------------------------------------------------------- composite */

export const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  /* far plane: z/w == 1 so the hardware depth test occludes the clouds behind
     terrain, trees and buildings with no depth texture required */
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uCloud;
uniform vec2  uTexel;
uniform float uOutGain;
uniform float uFallback;
uniform float uOpacity;

/*  NOTE ON "DEPTH AWARE":
 *  Occlusion against the world is resolved at FULL resolution by the hardware
 *  depth test (this quad sits on the far plane), which is exact and free — so
 *  the filter itself never has to reason about scene depth. It must NOT sample
 *  PostFX's depth texture either: that texture is attached to the very
 *  framebuffer this draw writes into, and GL kills the whole draw call as a
 *  feedback loop. What remains for the filter is the cloud's own silhouette,
 *  so the bilateral weight is driven by transmittance similarity, which keeps
 *  half-res cloud edges crisp instead of smearing them across the sky.
 */
void main() {
  vec4 c = texture2D(uCloud, vUv);

  vec4 acc = c;
  float wsum = 1.0;
  vec2 o[8];
  /* Wider than one texel on purpose. The march runs at half res and its
     silhouette is the only hard edge in the sky; sampled at exactly one texel
     the reconstruction still resolves as a 1-pixel staircase. The composite is
     a screen-space quad pinned to the raster, so PostFX's TAA jitter cannot
     anti-alias it either — this filter is the only thing that can. */
  o[0] = vec2( 1.15 * uTexel.x,  1.15 * uTexel.y);
  o[1] = vec2(-1.15 * uTexel.x,  1.15 * uTexel.y);
  o[2] = vec2( 1.15 * uTexel.x, -1.15 * uTexel.y);
  o[3] = vec2(-1.15 * uTexel.x, -1.15 * uTexel.y);
  o[4] = vec2( 1.60 * uTexel.x, 0.0);
  o[5] = vec2(-1.60 * uTexel.x, 0.0);
  o[6] = vec2(0.0,  1.60 * uTexel.y);
  o[7] = vec2(0.0, -1.60 * uTexel.y);
  /* TIGHTENED, and the alpha term made much sharper.
     At the old radii and weights the centre texel carried 14 % of the result
     and the kernel spanned ~4 full-res pixels — on top of a 0.45-res march and
     a 0.92 temporal blend. That triple smoothing is why every cloud in the set
     reads as an airbrushed blob whose margin dissolves into nothing rather
     than into wisps: the reconstruction was destroying the erosion detail the
     density field had gone to some trouble to produce. Narrower taps and a
     2.2x steeper transmittance falloff keep the AA where the silhouette is
     genuinely soft and stop averaging across it where it is not. */
  for (int i = 0; i < 8; i++) {
    vec4 s = texture2D(uCloud, vUv + o[i]);
    /* 2.0/0.46/0.40 -> 1.45/0.54/0.50. The motion gate's shimmer heatmap put
       visible heat on the newly-crisp cloud margins: the sharper the
       reconstruction, the less the half-res march's own sampling noise gets
       averaged away, and an advecting eroded fringe then scintillates. This
       keeps most of the sharpening (the kernel is still far tighter than the
       1.35/1.85 at 0.62/0.86 it replaced) while putting enough weight back on
       the neighbours for the temporal resolve to converge on them. */
    float w = exp(-abs(s.a - c.a) * 1.45) * (i < 4 ? 0.54 : 0.50);
    acc += s * w;
    wsum += w;
  }
  vec4 col = acc / wsum;

  vec3 rgb = col.rgb;
  float a = clamp(col.a, 0.0, 1.0) * uOpacity;
  rgb *= uOpacity;

  if (uFallback > 0.5) {
    /* PostFX has not taken over the tonemap yet — apply a gentle filmic curve
       plus the sRGB encode so the captured frame is actually viewable. */
    vec3 x = rgb * uOutGain;
    x = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    rgb = pow(clamp(x, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  /* Blending is premultiplied (One, 1-SrcAlpha), so a fragment with alpha 0
     and non-zero rgb is pure additive light — which is exactly what a
     lightning channel in otherwise clear sky is. Discarding on alpha alone
     would throw the bolt away. */
  if (a < 0.0012 && max(rgb.r, max(rgb.g, rgb.b)) < 0.0025) discard;
  gl_FragColor = vec4(rgb, a);
}
`;
