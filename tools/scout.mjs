/**
 * Adversarial camera scout.
 *
 * The ten canonical shots are ten viewpoints, and anything judged only at those
 * ten will be overfitted to them. RDR2 survives ANY camera — that is the real
 * bar. This walks the world with seeded random poses, captures each, scores them
 * cheaply, and surfaces the UGLIEST frames it can find as new findings.
 *
 *   node tools/scout.mjs --out shots/scout4 --n 40 --worst 6
 *
 * Cheap heuristic score (no model, no LLM): a frame is "suspicious" when it is
 * blown out or crushed, has no tonal range, is chromatically dead, or shows a
 * hard sky/terrain step. The worst N are written out full-size for a critic to
 * look at, with a JSON manifest of why each was flagged.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

/** mulberry32 — same PRNG the game uses, so scout runs are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const outDir = path.resolve(ROOT, arg('out', 'shots/scout'));
  const N = parseInt(arg('n', '40'), 10);
  const WORST = parseInt(arg('worst', '6'), 10);
  const seed = parseInt(arg('seed', '99'), 10);
  const W = parseInt(arg('w', '1280'), 10);
  const H = parseInt(arg('h', '720'), 10);
  const quality = arg('quality', 'medium');

  const server = await createServer({
    root: ROOT, logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  await page.goto(`${url}/?quality=${quality}&capture=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME && window.__GAME.ready === true,
    null, { timeout: 180000, polling: 250 });

  await mkdir(outDir, { recursive: true });
  const r = rng(seed);
  const candidates = [];

  for (let i = 0; i < N; i++) {
    // Random pose across the whole playable square, random hour, random weather.
    const x = (r() * 2 - 1) * 3200;
    const z = (r() * 2 - 1) * 3200;
    const eye = 1.7 + r() * 26;            // from head height to a low ridge
    const yaw = r() * Math.PI * 2;
    const pitch = -0.34 + r() * 0.42;
    const tod = r() * 24;
    const weather = ['clear', 'fair', 'overcast', 'rain', 'storm', 'fog'][(r() * 6) | 0];

    const score = await page.evaluate(({ x, z, eye, yaw, pitch, tod, weather }) => {
      const g = window.__GAME, T = g.THREE;
      const tod$ = g.ctx.systems.get('timeOfDay');
      if (tod$ && tod$.setTime) tod$.setTime(tod);
      const w$ = g.ctx.systems.get('weather');
      if (w$ && w$.setWeather) w$.setWeather(weather, { instant: true });

      const h = g.ctx.world.ready ? g.ctx.world.getHeight(x, z) : 0;
      const pos = new T.Vector3(x, h + eye, z);
      const look = new T.Vector3(
        x + Math.cos(yaw) * 120,
        h + eye + Math.tan(pitch) * 120,
        z + Math.sin(yaw) * 120,
      );
      const rig = g.ctx.systems.get('camera');
      if (rig && rig.setFreeCamera) rig.setFreeCamera(pos, look, 52);
      else { g.engine.camera.position.copy(pos); g.engine.camera.lookAt(look); }
      g.ctx.player.position.copy(pos);
      g.ctx.emit('teleport', pos);
      g.renderFrames(46);

      // Read back a downsampled frame and score it without leaving the page.
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 90;
      const c2 = cv.getContext('2d');
      c2.drawImage(g.engine.renderer.domElement, 0, 0, 160, 90);
      const d = c2.getImageData(0, 0, 160, 90).data;
      let n = 0, sum = 0, blown = 0, crushed = 0, satSum = 0;
      const lum = [];
      for (let p = 0; p < d.length; p += 4) {
        const R = d[p] / 255, G = d[p + 1] / 255, B = d[p + 2] / 255;
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        satSum += mx > 0 ? (mx - mn) / mx : 0;
        if (L > 0.985) blown++;
        if (L < 0.012) crushed++;
        sum += L; lum.push(L); n++;
      }
      lum.sort((a, b) => a - b);
      const p01 = lum[Math.floor(n * 0.01)], p99 = lum[Math.floor(n * 0.99)];
      return {
        mean: sum / n, range: p99 - p01, blown: blown / n, crushed: crushed / n,
        sat: satSum / n, stats: g.stats(),
      };
    }, { x, z, eye, yaw, pitch, tod, weather });

    // Higher = uglier. Each term is a failure this project has actually shipped.
    const ugly =
      score.blown * 5.0 +                              // clipped to white
      score.crushed * 3.0 +                            // crushed to black
      Math.max(0, 0.34 - score.range) * 4.0 +          // no tonal range (white-out)
      Math.max(0, 0.05 - score.sat) * 6.0 +            // chromatically dead
      Math.max(0, score.mean - 0.72) * 3.0 +           // overexposed overall
      Math.max(0, 0.07 - score.mean) * 3.0 +           // black frame
      Math.max(0, score.stats.frameMs - 16.7) / 40;    // and slow counts as ugly

    candidates.push({ i, x, z, eye, yaw, pitch, tod, weather, ugly, ...score });
    if ((i + 1) % 10 === 0) process.stdout.write(`  scouted ${i + 1}/${N}\n`);
  }

  candidates.sort((a, b) => b.ugly - a.ugly);
  const worst = candidates.slice(0, WORST);

  for (let k = 0; k < worst.length; k++) {
    const c = worst[k];
    await page.evaluate(({ x, z, eye, yaw, pitch, tod, weather }) => {
      const g = window.__GAME, T = g.THREE;
      const t$ = g.ctx.systems.get('timeOfDay'); if (t$ && t$.setTime) t$.setTime(tod);
      const w$ = g.ctx.systems.get('weather'); if (w$ && w$.setWeather) w$.setWeather(weather, { instant: true });
      const h = g.ctx.world.getHeight(x, z);
      const pos = new T.Vector3(x, h + eye, z);
      const look = new T.Vector3(x + Math.cos(yaw) * 120, h + eye + Math.tan(pitch) * 120, z + Math.sin(yaw) * 120);
      const rig = g.ctx.systems.get('camera');
      if (rig && rig.setFreeCamera) rig.setFreeCamera(pos, look, 52);
      g.ctx.player.position.copy(pos); g.ctx.emit('teleport', pos);
      g.renderFrames(110);
    }, c);
    await page.screenshot({ path: path.join(outDir, `worst${k}_${c.weather}_${c.tod.toFixed(1)}h.png`) });
  }

  await writeFile(path.join(outDir, 'scout.json'), JSON.stringify({
    scouted: N, seed, worst, errors: errors.slice(0, 20),
    medianUgly: candidates[Math.floor(candidates.length / 2)].ugly,
  }, null, 1));

  console.log(`\nscouted ${N} random poses; wrote the ${worst.length} ugliest to ${outDir}`);
  for (const c of worst) {
    console.log(`  ugly=${c.ugly.toFixed(3)} ${c.weather} @${c.tod.toFixed(1)}h `
      + `range=${c.range.toFixed(3)} blown=${(c.blown * 100).toFixed(1)}% `
      + `crushed=${(c.crushed * 100).toFixed(1)}% ${c.stats.frameMs.toFixed(0)}ms`);
  }
  if (errors.length) console.log(`  ${errors.length} page errors during scouting`);

  await browser.close();
  await server.close();
}

main();
