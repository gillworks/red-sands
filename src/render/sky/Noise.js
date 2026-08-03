/** Deterministic GPU value noise. No Math.random anywhere — pure hashing. */
export const NOISE_GLSL = /* glsl */`
#ifndef RS_NOISE_INCLUDED
#define RS_NOISE_INCLUDED

float rsHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float rsVNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = rsHash13(i + vec3(0.0, 0.0, 0.0));
  float b = rsHash13(i + vec3(1.0, 0.0, 0.0));
  float c = rsHash13(i + vec3(0.0, 1.0, 0.0));
  float d = rsHash13(i + vec3(1.0, 1.0, 0.0));
  float e = rsHash13(i + vec3(0.0, 0.0, 1.0));
  float g = rsHash13(i + vec3(1.0, 0.0, 1.0));
  float h = rsHash13(i + vec3(0.0, 1.0, 1.0));
  float k = rsHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
             mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

float rsFbm5(vec3 p) {
  float n = 0.0;
  n += 0.5000 * rsVNoise(p); p = p * 2.03 + vec3(17.1, 9.3, 5.7);
  n += 0.2500 * rsVNoise(p); p = p * 2.01 + vec3(5.2, 13.7, 21.3);
  n += 0.1250 * rsVNoise(p); p = p * 2.04 + vec3(11.9, 3.1, 7.7);
  n += 0.0625 * rsVNoise(p); p = p * 2.02 + vec3(29.3, 7.1, 15.1);
  n += 0.0312 * rsVNoise(p);
  return n * 1.0322;
}

float rsFbm3(vec3 p) {
  float n = 0.0;
  n += 0.5714 * rsVNoise(p); p = p * 2.03 + vec3(19.7, 4.3, 12.1);
  n += 0.2857 * rsVNoise(p); p = p * 2.01 + vec3(3.3, 27.9, 8.5);
  n += 0.1428 * rsVNoise(p);
  return n;
}
#endif
`;
