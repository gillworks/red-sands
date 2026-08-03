/**
 * Surface bake worker.
 *
 * `bakeSurface` is pure CPU maths over a square grid — three weighted fBm
 * bands, a cavity/convexity solve and a histogram stretch — and at 1024px it
 * costs ~300 ms per surface. Twenty-two surfaces are needed to boot the world,
 * so on the main thread that is 6.4 s of a 15 s boot spent doing something no
 * part of which touches the GPU, the DOM or any shared state.
 *
 * Running it here lets the pool bake every surface across all cores WHILE the
 * main thread is busy with terrain erosion, vegetation placement and town
 * layout. Nothing is transferred in but a recipe NAME (functions cannot cross
 * postMessage), so the worker imports the recipe table itself; the bake is
 * seed-free and deterministic, so the result is bit-identical to the main
 * thread's.
 *
 * Buffers come back as transferables — zero copy.
 */
import { RECIPES } from './Recipes.js';
import { bakeSurface, heightToNormalData } from './Bake.js';

self.onmessage = (e) => {
  const { id, name, size, disp, wi } = e.data;
  try {
    const recipe = RECIPES[name] || RECIPES.dirt_dry;
    const baked = bakeSurface(recipe, size);
    const normal = heightToNormalData(baked.height, size, (disp || 0.5) * 3.1);
    // `raw` is handed on as `heightData`; `height` (the sharpened field) is only
    // ever an input to the normal solve, which has already happened here.
    const msg = {
      id,
      wi,
      name,
      size,
      albedo: baked.albedo,
      rough: baked.rough,
      ao: baked.ao,
      normal,
      raw: baked.raw,
    };
    self.postMessage(msg, [
      baked.albedo.buffer, baked.rough.buffer, baked.ao.buffer,
      normal.buffer, baked.raw.buffer,
    ]);
  } catch (err) {
    self.postMessage({ id, wi, name, error: String((err && err.message) || err) });
  }
};
