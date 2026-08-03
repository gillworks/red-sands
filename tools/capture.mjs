/**
 * Headless capture harness.
 *
 *   node tools/capture.mjs --smoke                 boot check, reports console errors
 *   node tools/capture.mjs --out shots/run1        capture the full shot list
 *   node tools/capture.mjs --out s --only golden_hour_vista,town_street
 *   node tools/capture.mjs --out s --w 1920 --h 1080 --settle 180
 *
 * Runs its own isolated Vite dev server on an ephemeral port, so many agents
 * can capture in parallel without fighting over one server.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Canonical viewpoints. Each is a deterministic scene state + camera pose. */
export const SHOTS = {
  golden_hour_vista: {
    desc: 'Wide valley vista, low golden sun, long shadows, haze layers',
    tod: 18.15, weather: 'clear',
    cam: { pos: [-420, 96, 610], look: [180, 34, -140], fov: 46 },
  },
  dawn_mist_valley: {
    desc: 'Cold blue dawn, ground mist in the low ground, sun just cresting',
    tod: 6.1, weather: 'fair',
    cam: { pos: [240, 58, -300], look: [-150, 30, -520], fov: 52 },
  },
  high_noon_desert: {
    desc: 'Harsh overhead light, heat haze, arid rock and scrub',
    tod: 12.4, weather: 'clear',
    cam: { pos: [700, 44, 240], look: [1150, 30, 480], fov: 58 },
  },
  town_street: {
    desc: 'Main street of the settlement, buildings, props, warm afternoon',
    tod: 16.5, weather: 'fair',
    cam: { pos: 'town', look: 'town_end', fov: 50 },
  },
  night_camp: {
    desc: 'Deep night, campfire as the key light, stars and milky way visible',
    tod: 23.4, weather: 'clear',
    cam: { pos: 'camp', look: 'camp_fire', fov: 44 },
  },
  storm_plains: {
    desc: 'Heavy rain, wet ground, dark towering cloud, wind-lashed grass',
    tod: 15.0, weather: 'storm',
    cam: { pos: [-900, 52, -680], look: [-400, 40, -240], fov: 55 },
  },
  river_bend: {
    desc: 'Water surface, reflections, refraction, foam at the bank',
    tod: 10.2, weather: 'clear',
    cam: { pos: 'river', look: 'river_down', fov: 50 },
  },
  forest_interior: {
    desc: 'Inside the treeline, dappled light through canopy, undergrowth',
    tod: 9.3, weather: 'fair',
    cam: { pos: 'forest', look: 'forest_fwd', fov: 60 },
  },
  player_third_person: {
    desc: 'Over-the-shoulder gameplay framing with the character and horse',
    tod: 17.2, weather: 'fair',
    cam: { pos: 'player_ots', look: 'player_fwd', fov: 48 },
  },
  moonlit_ridge: {
    desc: 'Blue moonlit ridgeline, volumetric night haze, silhouettes',
    tod: 1.6, weather: 'fair',
    cam: { pos: [-120, 180, 420], look: [420, 90, -80], fov: 50 },
  },
};

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function main() {
  const smoke = !!arg('smoke');
  const motion = !!arg('motion');
  const outDir = path.resolve(ROOT, arg('out', 'shots/latest'));
  // --fast: iteration mode. Same code paths, ~4x cheaper. Use it for every
  // intermediate look; only run the full-fat settings for a final judgement.
  const fast = !!arg('fast');
  const W = parseInt(arg('w', fast ? '1280' : '1920'), 10);
  const H = parseInt(arg('h', fast ? '720' : '1080'), 10);
  const settleFrames = parseInt(arg('settle', fast ? '48' : '150'), 10);
  const only = arg('only', null);
  const quality = arg('quality', fast ? 'medium' : 'ultra');

  const list = only
    ? String(only).split(',').map((s) => s.trim()).filter((s) => SHOTS[s])
    : Object.keys(SHOTS);

  const server = await createServer({
    root: ROOT,
    logLevel: 'error',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0].replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle', '--use-angle=metal',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-zero-copy',
      '--disable-frame-rate-limit', '--disable-gpu-vsync',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') errors.push(m.text());
    else if (t === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e && e.message ? e.message : String(e))));

  const report = { url, shots: [], errors, warnings: [], ok: true, timings: {} };
  const t0 = Date.now();

  try {
    await page.goto(`${url}/?quality=${quality}&capture=1`, { waitUntil: 'load', timeout: 120000 });

    // Wait for the game to report readiness.
    await page.waitForFunction(
      () => window.__GAME && window.__GAME.ready === true,
      null,
      { timeout: 180000, polling: 250 },
    );
    report.timings.bootMs = Date.now() - t0;

    if (motion) {
      // Temporal capture. Two sequences per shot, both judged by tools/motion.py:
      //  static/ — camera frozen, N frames. Anything that moves here is an
      //            artifact: cascade shimmer, specular crawl, TAA instability,
      //            alpha-test dither. Per-pixel variance makes it measurable.
      //  dolly/  — camera tracks forward, N frames, for LOD pop / ghosting and
      //            for a filmstrip a vision critic can judge motion from.
      const list2 = only
        ? String(only).split(',').map((s) => s.trim()).filter((s) => SHOTS[s])
        : ['golden_hour_vista', 'forest_interior'];
      const N = parseInt(arg('frames', '24'), 10);
      for (const name of list2) {
        const shot = SHOTS[name];
        await page.evaluate((s) => window.__GAME.setupShot(s), { name, ...shot });
        await page.evaluate((n) => window.__GAME.renderFrames(n), settleFrames);

        const sdir = path.join(outDir, 'static', name);
        await mkdir(sdir, { recursive: true });
        for (let i = 0; i < N; i++) {
          await page.evaluate(() => window.__GAME.renderFrames(1));
          await page.screenshot({ path: path.join(sdir, `f${String(i).padStart(3, '0')}.png`) });
        }

        const ddir = path.join(outDir, 'dolly', name);
        await mkdir(ddir, { recursive: true });
        await page.evaluate((s) => window.__GAME.setupShot(s), { name, ...shot });
        await page.evaluate((n) => window.__GAME.renderFrames(n), settleFrames);
        for (let i = 0; i < N; i++) {
          await page.evaluate(({ step }) => {
            const g = window.__GAME, T = g.THREE;
            const cam = g.engine.camera;
            /*
             * Nudging cam.position directly is a NO-OP: CameraRig.setFreeCamera
             * latches a pose and reasserts it every update(), silently undoing
             * the move — two agents independently found this dolly was static.
             * Re-latch the pose through the rig instead, so the move survives.
             */
            const fwd = new T.Vector3();
            cam.getWorldDirection(fwd);
            const pos = cam.position.clone().addScaledVector(fwd, step);
            if (g.ctx.world.ready) {
              const h = g.ctx.world.getHeight(pos.x, pos.z);
              if (pos.y < h + 1.7) pos.y = h + 1.7;
            }
            const look = pos.clone().addScaledVector(fwd, 120);
            const rig = g.ctx.systems.get('camera');
            if (rig && rig.setFreeCamera) rig.setFreeCamera(pos, look, cam.fov);
            else { cam.position.copy(pos); cam.lookAt(look); }
            g.ctx.player.position.copy(pos);
            g.renderFrames(1);
          }, { step: 0.9 });   // ~0.9 m/frame ≈ a brisk walk at 60fps
          await page.screenshot({ path: path.join(ddir, `f${String(i).padStart(3, '0')}.png`) });
        }
        /*
         * suncycle/ — camera AND clock both running.
         *
         * `?capture=1` pauses TimeOfDay so screenshots are reproducible, which
         * means every sun-rate-driven defect is INVISIBLE to the static and
         * dolly sequences. That blind spot is exactly how the cloud-shadow
         * flicker reached a human playtester without any gate firing: all three
         * of its root causes were functions of sun altitude, and the sun never
         * moved. Here we resume the clock and run it fast, so anything that
         * updates on an interval or re-quantises against the sun shows up.
         */
        const cdir = path.join(outDir, 'suncycle', name);
        await mkdir(cdir, { recursive: true });
        await page.evaluate((s) => window.__GAME.setupShot(s), { name, ...shot });
        await page.evaluate((n) => window.__GAME.renderFrames(n), settleFrames);
        const clockRan = await page.evaluate(() => {
          const t = window.__GAME.ctx.systems.get('timeOfDay');
          if (!t || !t.resume) return false;
          if (t.setDayLength) t.setDayLength(90);  // 90s day => visible sun travel
          t.resume();
          return true;
        });
        for (let i = 0; i < N; i++) {
          await page.evaluate(() => window.__GAME.renderFrames(1));
          await page.screenshot({ path: path.join(cdir, `f${String(i).padStart(3, '0')}.png`) });
        }
        await page.evaluate(() => {
          const t = window.__GAME.ctx.systems.get('timeOfDay');
          if (t && t.pause) t.pause();
        });

        process.stdout.write(`  motion ${name}: ${N} static + ${N} dolly + ${N} suncycle`
          + `${clockRan ? '' : ' (CLOCK COULD NOT BE RESUMED)'}\n`);
        report.shots.push({ name, motion: true, frames: N, clockRan });
      }
    } else if (smoke) {
      // Advance a little so per-frame code paths actually execute.
      await page.evaluate((n) => window.__GAME.renderFrames(n), 60);
      await mkdir(outDir, { recursive: true });
      await page.screenshot({ path: path.join(outDir, 'smoke.png') });
      report.smoke = path.join(outDir, 'smoke.png');
      report.stats = await page.evaluate(() => window.__GAME.stats());
    } else {
      await mkdir(outDir, { recursive: true });
      for (const name of list) {
        const shot = SHOTS[name];
        const st = Date.now();
        await page.evaluate((s) => window.__GAME.setupShot(s), { name, ...shot });
        // Let streaming, LOD, TAA history and auto-exposure converge.
        await page.evaluate((n) => window.__GAME.renderFrames(n), settleFrames);
        const file = path.join(outDir, `${name}.png`);
        await page.screenshot({ path: file });
        const stats = await page.evaluate(() => window.__GAME.stats());

        /*
         * TRUE GPU-INCLUSIVE FRAME TIME.
         * engine.frameMs measures CPU submission only. It used to track GPU
         * cost by accident, because two per-frame readRenderTargetPixels calls
         * were stalling the pipeline; those were removed as an optimisation, so
         * the number became meaningless (it swings 13-46ms on identical builds).
         * Here we time a batch of frames and force GPU completion ONCE at the
         * end with a single pixel read, then divide. One stall amortised over N
         * frames gives a real average without distorting the thing we measure.
         */
        stats.gpuFrameMs = await page.evaluate((n) => {
          const g = window.__GAME;
          const gl = g.engine.renderer.getContext();
          g.renderFrames(4);                       // warm up
          const px = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // drain
          const t0 = performance.now();
          g.renderFrames(n);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // sync
          return (performance.now() - t0) / n;
        }, 30);
        report.shots.push({ name, file, desc: shot.desc, ms: Date.now() - st, stats });
        process.stdout.write(`  captured ${name}  (${stats.drawCalls} draws, ${stats.triangles} tris, ${stats.frameMs.toFixed(1)}ms)\n`);
      }
    }
  } catch (e) {
    report.ok = false;
    report.fatal = e && e.message ? e.message : String(e);
    try {
      await mkdir(outDir, { recursive: true });
      await page.screenshot({ path: path.join(outDir, 'FAILURE.png') });
    } catch { /* page may be dead */ }
  }

  // Filter the noise floor out of warnings.
  report.warnings = warnings.filter((w) => !/DevTools|Download the React|source map/i.test(w)).slice(0, 40);
  report.errors = errors.slice(0, 40);
  if (report.errors.length) report.ok = false;
  report.totalMs = Date.now() - t0;

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  await server.close();

  console.log(JSON.stringify({
    ok: report.ok,
    bootMs: report.timings.bootMs,
    shots: report.shots.length,
    errors: report.errors,
    fatal: report.fatal,
    stats: report.stats,
  }, null, 2));

  // Boot time is the dominant cost of every iteration loop; surface it loudly.
  if (report.timings.bootMs > 6000) {
    console.log(`\n⚠  BOOT TOOK ${(report.timings.bootMs / 1000).toFixed(1)}s.`
      + ` Budget is 5s. Every capture pays this. If your system does heavy work`
      + ` in init(), cache it, lower its resolution, or defer it off the boot path.`);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
