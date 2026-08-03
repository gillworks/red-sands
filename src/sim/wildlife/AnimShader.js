/**
 * Vertex-shader locomotion for the wildlife instances.
 *
 * Per-instance input is one vec4:
 *    aAnim.x  gait phase in radians — advanced by DISTANCE TRAVELLED on the
 *             CPU, not by time, so hooves never skate when an animal changes
 *             speed. This is the single thing that separates "animated model"
 *             from "creature that is actually walking".
 *    aAnim.y  0..1 how much gait to apply (0 = standing still)
 *    aAnim.z  posture: for quadrupeds, head pitch (-1 grazing … +0.3 alert);
 *             for birds, wing dihedral (0 glide … 1 climb)
 *    aAnim.w  speed in m/s, used for stride length and wing sweep
 *
 * Per-vertex input is aPart (which limb) and aPivot (the joint it swings on).
 */

export const ANIM_PARS = /* glsl */`
attribute float aPart;
attribute vec3  aPivot;
attribute vec4  aAnim;

vec3 wlRotX(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}
vec3 wlRotZ(vec3 p, vec3 pivot, float a) {
  vec3 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
`;

export const ANIM_BEGIN = /* glsl */`
vec3 transformed = vec3(position);
{
  float ph = aAnim.x;
  float gait = aAnim.y;
  float post = aAnim.z;
  float spd = aAnim.w;
  float part = aPart + 0.5;

  if (part > 2.0 && part < 6.0) {
    /* ---- legs -------------------------------------------------------
       Diagonal pairs move together (a trot). The swing is asymmetric:
       the forward reach is a smooth sine, the stance phase is flattened,
       which is what stops a quadruped looking like a pendulum toy. */
    float off = (part < 3.0 || part > 5.0) ? 0.0 : 3.14159265;
    if (part > 4.0 && part < 5.0) off = 3.14159265;   // BL pairs with FR
    if (part > 5.0) off = 0.0;                        // BR pairs with FL
    float s = sin(ph + off);
    float swing = s * (0.12 + gait * 0.62);
    // lift the foot only on the forward half of the cycle
    float lift = max(0.0, s) * gait * 0.10;
    vec3 d = transformed - aPivot;
    // swing about the hip in the sagittal plane (X-Y)
    float c = cos(swing), sn = sin(swing);
    transformed = aPivot + vec3(d.x * c - d.y * sn, d.x * sn + d.y * c, d.z);
    transformed.y += lift * max(0.0, -d.y);
  } else if (part > 1.0 && part < 2.0) {
    /* ---- head / neck: graze, alert, and a small bob in step ---------- */
    float bob = sin(ph * 2.0) * 0.045 * gait;
    transformed = wlRotZ(transformed, aPivot, post * 0.9 + bob);
  } else if (part > 6.0 && part < 7.0) {
    /* ---- tail: flicks, and streams out at speed ---------------------- */
    float f = sin(ph * 0.9) * 0.22 + sin(ph * 3.7) * 0.06;
    transformed = wlRotZ(transformed, aPivot, f * (0.4 + gait) + min(spd, 9.0) * 0.03);
  } else if (part > 7.0) {
    /* ---- wings ------------------------------------------------------
       Flap about the roll axis, with a slight sweep so the tip leads on
       the downstroke. aAnim.z holds the dihedral: a gliding raptor keeps
       its wings out flat, a climbing bird beats hard. (aAnim.z) */
    float side = (part < 8.0) ? 1.0 : -1.0;
    float beat = sin(ph);
    float amp = mix(0.12, 1.05, clamp(post, 0.0, 1.0)) * gait;
    float a = beat * amp + 0.10;
    vec3 d = transformed - aPivot;
    float c = cos(a * side), sn = sin(a * side);
    // rotate about the fore-aft (X) axis => the wing goes up and down
    transformed = aPivot + vec3(d.x, d.y * c - d.z * sn, d.y * sn + d.z * c);
    // tip leads the stroke a little
    transformed.x += -beat * 0.10 * abs(d.z) * gait;
  }
}
`;
